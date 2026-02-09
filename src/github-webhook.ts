import { EventEmitter } from 'node:events';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Logger } from './logger';
import { FollowupManager } from './followup-manager';
import { ClaimEvent, FollowupSourceEventType } from './types';

interface GitHubWebhookConnectorOptions {
  apiKey: string;
  webhookSecret?: string;
  followups: FollowupManager;
  logger: Logger;
  maxSeenDeliveries?: number;
  webhookDedupe?: WebhookDeliveryDedupe;
}

interface ProcessWebhookInput {
  headers: Headers;
  rawBody: string;
}

interface ProcessWebhookResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

interface ParsedGitHubEvent {
  eventType: string;
  deliveryId?: string;
  payload: Record<string, any>;
}

interface WebhookDeliveryDedupe {
  markDeliveryIfNew(deliveryId: string): Promise<boolean>;
}

export class GitHubWebhookConnector {
  private readonly apiKey: string;
  private readonly webhookSecret?: string;
  private readonly followups: FollowupManager;
  private readonly logger: Logger;
  private readonly maxSeenDeliveries: number;
  private readonly webhookDedupe?: WebhookDeliveryDedupe;
  private readonly seenDeliveries: string[] = [];
  private readonly seenDeliverySet = new Set<string>();
  private readonly events = new EventEmitter();

  constructor(options: GitHubWebhookConnectorOptions) {
    this.apiKey = options.apiKey;
    this.webhookSecret = options.webhookSecret;
    this.followups = options.followups;
    this.logger = options.logger;
    this.maxSeenDeliveries = Math.max(100, options.maxSeenDeliveries ?? 20_000);
    this.webhookDedupe = options.webhookDedupe;
  }

  onEvent(listener: (event: ClaimEvent) => void): () => void {
    this.events.on('webhook_event', listener);
    return () => {
      this.events.off('webhook_event', listener);
    };
  }

  async process(input: ProcessWebhookInput): Promise<ProcessWebhookResult> {
    const authResult = this.authorize(input.headers, input.rawBody);
    if (!authResult.ok) {
      this.logger.warn('webhook.github.rejected', {
        reason: authResult.reason,
      });
      this.emitEvent('webhook.rejected', {
        reason: authResult.reason,
      });
      return {
        ok: false,
        status: 401,
        body: {
          ok: false,
          error: 'unauthorized_webhook',
          reason: authResult.reason,
        },
      };
    }

    const parsed = this.parseEvent(input.headers, input.rawBody);
    if (!parsed.ok) {
      this.emitEvent('webhook.rejected', {
        reason: parsed.reason,
      });
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: 'invalid_webhook_payload',
          reason: parsed.reason,
        },
      };
    }

    const deliveryId = parsed.event.deliveryId;
    if (deliveryId && this.hasSeenDelivery(deliveryId)) {
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          duplicate: true,
          delivery_id: deliveryId,
        },
      };
    }

    if (deliveryId) {
      if (this.webhookDedupe) {
        const isNewDelivery = await this.webhookDedupe.markDeliveryIfNew(deliveryId);
        if (!isNewDelivery) {
          this.addSeenDelivery(deliveryId);
          return {
            ok: true,
            status: 200,
            body: {
              ok: true,
              duplicate: true,
              delivery_id: deliveryId,
            },
          };
        }
      }

      this.addSeenDelivery(deliveryId);
    }

    const processResult = await this.processParsedEvent(parsed.event);
    this.emitEvent('webhook.received', {
      auth_method: authResult.method,
      event_type: parsed.event.eventType,
      delivery_id: parsed.event.deliveryId,
      ...processResult,
    });

    return {
      ok: true,
      status: 202,
      body: {
        ok: true,
        ...processResult,
      },
    };
  }

  private authorize(headers: Headers, rawBody: string):
    | { ok: true; method: 'signature' | 'api_key' }
    | { ok: false; reason: string } {
    const authorization = headers.get('authorization');
    if (authorization && authorization === `Bearer ${this.apiKey}`) {
      return {
        ok: true,
        method: 'api_key',
      };
    }

    const signature = headers.get('x-hub-signature-256');
    if (signature && this.webhookSecret) {
      if (this.isValidSignature(signature, rawBody)) {
        return {
          ok: true,
          method: 'signature',
        };
      }

      return {
        ok: false,
        reason: 'invalid_signature',
      };
    }

    return {
      ok: false,
      reason: 'missing_valid_signature_or_api_key',
    };
  }

  private isValidSignature(signatureHeader: string, rawBody: string): boolean {
    const prefix = 'sha256=';
    if (!signatureHeader.startsWith(prefix)) {
      return false;
    }

    const received = signatureHeader.slice(prefix.length);
    const expected = createHmac('sha256', this.webhookSecret ?? '').update(rawBody).digest('hex');

    const receivedBuffer = Buffer.from(received, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(receivedBuffer, expectedBuffer);
  }

  private parseEvent(headers: Headers, rawBody: string):
    | { ok: true; event: ParsedGitHubEvent }
    | { ok: false; reason: string } {
    const eventType = headers.get('x-github-event');
    if (!eventType) {
      return {
        ok: false,
        reason: 'missing_x_github_event_header',
      };
    }

    try {
      const payload = JSON.parse(rawBody) as Record<string, any>;
      if (!payload || typeof payload !== 'object') {
        return {
          ok: false,
          reason: 'payload_must_be_an_object',
        };
      }

      return {
        ok: true,
        event: {
          eventType,
          deliveryId: headers.get('x-github-delivery') ?? undefined,
          payload,
        },
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'invalid_json',
      };
    }
  }

  private async processParsedEvent(event: ParsedGitHubEvent): Promise<Record<string, unknown>> {
    const payload = event.payload;

    if (event.eventType === 'pull_request') {
      if (payload.action !== 'synchronize') {
        return {
          ignored: true,
          reason: `pull_request action ${String(payload.action)} is not handled`,
        };
      }

      const repo = String(payload.repository?.full_name ?? '');
      const prNumber = Number(payload.pull_request?.number ?? 0);
      if (!repo || !Number.isFinite(prNumber) || prNumber <= 0) {
        return {
          ignored: true,
          reason: 'missing_repo_or_pr_number',
        };
      }

      const sourceEventId = `${event.deliveryId ?? randomUUID()}:pull_request:synchronize`;
      const resolved = await this.followups.resolveBySynchronize({
        repo,
        pr_number: prNumber,
        source_event_id: sourceEventId,
        source_delivery_id: event.deliveryId,
      });

      return {
        processed: true,
        event_type: event.eventType,
        action: payload.action,
        resolved_followups: resolved,
      };
    }

    const normalized = this.normalizeFollowupCreationEvent(event);
    if (!normalized) {
      return {
        ignored: true,
        reason: `event ${event.eventType} is not actionable`,
      };
    }

    const validation = validateNormalizedFollowup(normalized);
    if (!validation.ok) {
      return {
        ignored: true,
        reason: validation.reason,
      };
    }

    const createResult = await this.followups.createFromWebhook(normalized);

    return {
      processed: true,
      event_type: event.eventType,
      source_event_type: normalized.source_event_type,
      created: createResult.ok,
      idempotent: createResult.idempotent ?? false,
      work_item_id: createResult.work_item?.work_item_id,
      repo: normalized.repo,
      pr_number: normalized.pr_number,
    };
  }

  private normalizeFollowupCreationEvent(event: ParsedGitHubEvent): {
    repo: string;
    pr_number: number;
    pr_url: string;
    pr_title: string;
    source_event_type: FollowupSourceEventType;
    source_event_id: string;
    source_delivery_id?: string;
    requested_by?: string;
    summary: string;
    actionable_comments: string[];
  } | null {
    const payload = event.payload;

    if (event.eventType === 'pull_request_review') {
      if (payload.action !== 'submitted') {
        return null;
      }
      if (String(payload.review?.state ?? '').toLowerCase() !== 'changes_requested') {
        return null;
      }

      return {
        repo: String(payload.repository?.full_name ?? ''),
        pr_number: Number(payload.pull_request?.number ?? 0),
        pr_url: String(payload.pull_request?.html_url ?? ''),
        pr_title: String(payload.pull_request?.title ?? ''),
        source_event_type: 'review_changes_requested',
        source_event_id: `review:${String(payload.review?.id ?? event.deliveryId ?? randomUUID())}`,
        source_delivery_id: event.deliveryId,
        requested_by: String(payload.review?.user?.login ?? ''),
        summary: String(payload.review?.body ?? '').trim() || 'Changes requested on pull request',
        actionable_comments: [String(payload.review?.body ?? '').trim()].filter(Boolean),
      };
    }

    if (event.eventType === 'pull_request_review_comment') {
      if (payload.action !== 'created') {
        return null;
      }

      return {
        repo: String(payload.repository?.full_name ?? ''),
        pr_number: Number(payload.pull_request?.number ?? 0),
        pr_url: String(payload.pull_request?.html_url ?? ''),
        pr_title: String(payload.pull_request?.title ?? ''),
        source_event_type: 'review_comment',
        source_event_id: `review_comment:${String(payload.comment?.id ?? event.deliveryId ?? randomUUID())}`,
        source_delivery_id: event.deliveryId,
        requested_by: String(payload.comment?.user?.login ?? ''),
        summary: String(payload.comment?.body ?? '').trim() || 'New PR review comment',
        actionable_comments: [String(payload.comment?.body ?? '').trim()].filter(Boolean),
      };
    }

    if (event.eventType === 'issue_comment') {
      if (payload.action !== 'created') {
        return null;
      }

      if (!payload.issue?.pull_request) {
        return null;
      }

      return {
        repo: String(payload.repository?.full_name ?? ''),
        pr_number: Number(payload.issue?.number ?? 0),
        pr_url: String(payload.issue?.html_url ?? ''),
        pr_title: String(payload.issue?.title ?? ''),
        source_event_type: 'pr_comment',
        source_event_id: `issue_comment:${String(payload.comment?.id ?? event.deliveryId ?? randomUUID())}`,
        source_delivery_id: event.deliveryId,
        requested_by: String(payload.comment?.user?.login ?? ''),
        summary: String(payload.comment?.body ?? '').trim() || 'New PR issue comment',
        actionable_comments: [String(payload.comment?.body ?? '').trim()].filter(Boolean),
      };
    }

    return null;
  }

  private hasSeenDelivery(deliveryId: string): boolean {
    return this.seenDeliverySet.has(deliveryId);
  }

  private addSeenDelivery(deliveryId: string): void {
    if (!deliveryId) {
      return;
    }

    if (this.seenDeliverySet.has(deliveryId)) {
      return;
    }

    this.seenDeliveries.unshift(deliveryId);
    this.seenDeliverySet.add(deliveryId);

    if (this.seenDeliveries.length <= this.maxSeenDeliveries) {
      return;
    }

    const removed = this.seenDeliveries.pop();
    if (removed) {
      this.seenDeliverySet.delete(removed);
    }
  }

  private emitEvent(type: ClaimEvent['type'], details: Record<string, unknown>): void {
    const event: ClaimEvent = {
      event_id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      details,
    };

    this.events.emit('webhook_event', event);
  }
}

function validateNormalizedFollowup(input: {
  repo: string;
  pr_number: number;
  source_event_id: string;
}): { ok: true } | { ok: false; reason: string } {
  const repo = input.repo.trim();
  const repoParts = repo.split('/').map((item) => item.trim()).filter(Boolean);
  if (repoParts.length !== 2) {
    return {
      ok: false,
      reason: 'invalid_repo_in_webhook_payload',
    };
  }

  if (!Number.isInteger(input.pr_number) || input.pr_number <= 0) {
    return {
      ok: false,
      reason: 'invalid_pr_number_in_webhook_payload',
    };
  }

  if (!input.source_event_id.trim()) {
    return {
      ok: false,
      reason: 'missing_source_event_id',
    };
  }

  return { ok: true };
}
