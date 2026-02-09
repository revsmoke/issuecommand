import { randomUUID } from 'node:crypto';
import { ClaimManager } from './claim-manager';
import { FollowupManager } from './followup-manager';
import { GitHubWebhookConnector } from './github-webhook';
import { Logger } from './logger';
import { TokenBucketLimiter } from './rate-limit';
import { SyncService } from './sync';
import { AppConfig, ClaimEvent, ClaimStatus, FollowupStatus } from './types';
import { IssueCommandService } from './issuecommand-service';

interface HttpServerOptions {
  service: IssueCommandService;
  claims: ClaimManager;
  followups?: FollowupManager;
  sync: SyncService;
  webhooks?: GitHubWebhookConnector;
  config: AppConfig;
  logger: Logger;
}

interface RunningHttpServer {
  stop: () => void;
  port: number;
}

class ClientInputError extends Error {
  readonly status = 400;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export function startHttpServer(options: HttpServerOptions): RunningHttpServer {
  const sseClients = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const ipLimiter = options.config.rateLimit.enabled
    ? new TokenBucketLimiter({
        ratePerMinute: options.config.rateLimit.ipPerMinute,
        burst: options.config.rateLimit.ipBurst,
      })
    : undefined;
  const mutationLimiter = options.config.rateLimit.enabled
    ? new TokenBucketLimiter({
        ratePerMinute: options.config.rateLimit.agentMutationsPerMinute,
        burst: options.config.rateLimit.agentMutationsBurst,
      })
    : undefined;
  const sseConnectLimiter = options.config.rateLimit.enabled
    ? new TokenBucketLimiter({
        ratePerMinute: options.config.rateLimit.sseConnectPerMinute,
        burst: options.config.rateLimit.sseConnectBurst,
      })
    : undefined;

  const broadcast = (event: ClaimEvent): void => {
    const payload = encodeSseEvent(encoder, event.type, event, event.event_id);

    for (const [clientId, controller] of sseClients) {
      try {
        controller.enqueue(payload);
      } catch {
        sseClients.delete(clientId);
      }
    }
  };

  const unsubscribeClaims = options.claims.onEvent(broadcast);
  const unsubscribeSync = options.sync.onEvent(broadcast);
  const unsubscribeFollowups = options.followups?.onEvent(broadcast);
  const unsubscribeWebhooks = options.webhooks?.onEvent(broadcast);

  const server = Bun.serve({
    port: options.config.httpPort,
    fetch: async (request, server) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const webhookPath = options.config.webhookPath;
      const isWebhookPath = options.config.webhookEnabled && pathname === webhookPath;
      const clientIp = getClientIp(request, server, options.config.trustProxy);

      const requiresApiAuth = (pathname.startsWith('/api') || pathname === '/sse') && !isWebhookPath;
      if (requiresApiAuth && !isAuthorized(request, options.config.apiKey)) {
        return json(
          {
            ok: false,
            error: 'unauthorized',
          },
          401,
        );
      }
      const mutationPrincipal = requiresApiAuth ? getMutationPrincipal(request) : undefined;

      if (pathname.startsWith('/api')) {
        const perIpLimit = checkRateLimit(ipLimiter, `ip:${clientIp}`);
        if (perIpLimit) {
          return rateLimitResponse('ip', perIpLimit);
        }
      }

      if (request.method === 'GET' && pathname === '/sse') {
        const sseLimit = checkRateLimit(sseConnectLimiter, `sse:${clientIp}`);
        if (sseLimit) {
          return rateLimitResponse('sse_connect', sseLimit);
        }

        return handleSseRequest(request, sseClients, encoder);
      }

      try {
        if (request.method === 'POST' && isWebhookPath) {
          if (!options.webhooks) {
            return json(
              {
                ok: false,
                error: 'webhook_not_configured',
              },
              503,
            );
          }

          const rawBody = await request.text();
          const response = await options.webhooks.process({
            headers: request.headers,
            rawBody,
          });

          return json(response.body, response.status);
        }

        if (request.method === 'GET' && pathname === '/api/repos') {
          const includeCounts = url.searchParams.get('include_counts') !== 'false';
          const response = await options.service.listRepos({ include_counts: includeCounts });
          return json(response);
        }

        const repoIssuesMatch = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/);
        if (request.method === 'GET' && repoIssuesMatch) {
          const repo = `${repoIssuesMatch[1]}/${repoIssuesMatch[2]}`;
          const response = await options.service.listOpenIssues({
            repo,
            label: url.searchParams.get('label') ?? undefined,
            milestone: url.searchParams.get('milestone') ?? undefined,
          });
          return json(response);
        }

        const issueDetailsMatch = pathname.match(/^\/api\/issues\/([^/]+)\/([^/]+)\/(\d+)$/);
        if (request.method === 'GET' && issueDetailsMatch) {
          const repo = `${issueDetailsMatch[1]}/${issueDetailsMatch[2]}`;
          const issueNumber = Number.parseInt(issueDetailsMatch[3], 10);
          const response = await options.service.getIssueDetails({
            repo,
            issue_number: issueNumber,
          });
          return json(response);
        }

        if (request.method === 'POST' && pathname === '/api/claims') {
          const body = await parseJsonBody(request);
          const agentId = requireString(body, 'agent_id');
          const mutationLimit = checkMutationRateLimit(mutationLimiter, mutationPrincipal, agentId);
          if (mutationLimit) {
            return rateLimitResponse('agent_mutation', mutationLimit);
          }

          const response = await options.service.claimIssue({
            agent_id: agentId,
            repo: requireString(body, 'repo'),
            issue_number: requireNumber(body, 'issue_number'),
          });
          return json(response, response.ok ? 200 : 409);
        }

        if (request.method === 'POST' && pathname === '/api/next') {
          const body = await parseJsonBody(request);
          const agentId = requireString(body, 'agent_id');
          const mutationLimit = checkMutationRateLimit(mutationLimiter, mutationPrincipal, agentId);
          if (mutationLimit) {
            return rateLimitResponse('agent_mutation', mutationLimit);
          }

          const response = await options.service.nextIssue({
            agent_id: agentId,
            repo: optionalString(body, 'repo'),
            label: optionalString(body, 'label'),
            milestone: optionalString(body, 'milestone'),
          });

          return json(response, response.ok ? 200 : 409);
        }

        if (request.method === 'POST' && pathname === '/api/next-work') {
          const body = await parseJsonBody(request);
          const agentId = requireString(body, 'agent_id');
          const mutationLimit = checkMutationRateLimit(mutationLimiter, mutationPrincipal, agentId);
          if (mutationLimit) {
            return rateLimitResponse('agent_mutation', mutationLimit);
          }

          const response = await options.service.nextWork({
            agent_id: agentId,
            repo: optionalString(body, 'repo'),
            label: optionalString(body, 'label'),
            milestone: optionalString(body, 'milestone'),
          });

          return json(response, response.ok ? 200 : 409);
        }

        if (request.method === 'GET' && pathname === '/api/followups') {
          const response = options.service.getFollowups({
            repo: url.searchParams.get('repo') ?? undefined,
            status: optionalFollowupStatus(url.searchParams.get('status')),
            claimed_by_agent_id: url.searchParams.get('claimed_by_agent_id') ?? undefined,
            pr_number: optionalNumber(url.searchParams.get('pr_number')),
          });
          return json(response);
        }

        if (request.method === 'GET' && pathname === '/api/my-work') {
          const agentId = url.searchParams.get('agent_id');
          if (!agentId || !agentId.trim()) {
            throw new ClientInputError('Missing required query parameter: agent_id');
          }

          const response = options.service.getMyWork({
            agent_id: agentId.trim(),
          });
          return json(response);
        }

        const claimPathMatch = pathname.match(/^\/api\/claims\/([^/]+)$/);
        if (claimPathMatch && request.method === 'DELETE') {
          const claimId = claimPathMatch[1];
          const body = await parseJsonBody(request, { optional: true });
          const agentId = requireString(body, 'agent_id');
          const mutationLimit = checkMutationRateLimit(mutationLimiter, mutationPrincipal, agentId);
          if (mutationLimit) {
            return rateLimitResponse('agent_mutation', mutationLimit);
          }

          const response = await options.service.releaseIssue({
            claim_id: claimId,
            agent_id: agentId,
            reason: optionalString(body, 'reason'),
          });

          return json(response, claimMutationStatusCode(response));
        }

        if (claimPathMatch && request.method === 'PATCH') {
          const claimId = claimPathMatch[1];
          const body = await parseJsonBody(request);
          const agentId = requireString(body, 'agent_id');
          const mutationLimit = checkMutationRateLimit(mutationLimiter, mutationPrincipal, agentId);
          if (mutationLimit) {
            return rateLimitResponse('agent_mutation', mutationLimit);
          }

          const response = await options.service.updateClaimStatus({
            claim_id: claimId,
            agent_id: agentId,
            status: requireStatus(body, 'status'),
            note: optionalString(body, 'note'),
            pr_url: optionalString(body, 'pr_url'),
          });

          return json(response, claimMutationStatusCode(response));
        }

        const followupPathMatch = pathname.match(/^\/api\/followups\/([^/]+)$/);
        if (followupPathMatch && request.method === 'PATCH') {
          const body = await parseJsonBody(request);
          const agentId = requireString(body, 'agent_id');
          const mutationLimit = checkMutationRateLimit(mutationLimiter, mutationPrincipal, agentId);
          if (mutationLimit) {
            return rateLimitResponse('agent_mutation', mutationLimit);
          }

          const response = await options.service.updateFollowupStatus({
            work_item_id: followupPathMatch[1],
            status: requireFollowupStatus(body, 'status'),
            note: optionalString(body, 'note'),
            agent_id: agentId,
          });

          const statusCode = response.ok ? 200 : response.reason === 'not_found' ? 404 : 409;
          return json(response, statusCode);
        }

        if (request.method === 'GET' && pathname === '/api/claims') {
          const response = options.service.getClaims({
            agent_id: url.searchParams.get('agent_id') ?? undefined,
            repo: url.searchParams.get('repo') ?? undefined,
            status: optionalStatus(url.searchParams.get('status')),
          });
          return json(response);
        }

        if (request.method === 'GET' && pathname === '/api/health') {
          const response = options.service.systemHealth();
          return json(response);
        }

        return json({ ok: false, error: 'not_found' }, 404);
      } catch (error) {
        const isClientError = error instanceof ClientInputError;
        options.logger.error('http.request_failed', {
          method: request.method,
          path: pathname,
          status: isClientError ? error.status : 500,
          message: error instanceof Error ? error.message : String(error),
        });

        if (!isClientError) {
          return json(
            {
              ok: false,
              error: 'internal_error',
              message: 'An unexpected server error occurred',
            },
            500,
          );
        }

        return json(
          {
            ok: false,
            error: 'request_failed',
            message: error.message,
          },
          error.status,
        );
      }
    },
  });

  options.logger.info('http.started', {
    port: options.config.httpPort,
  });

  return {
    port: Number(server.port ?? options.config.httpPort),
    stop: () => {
      unsubscribeClaims();
      unsubscribeSync();
      unsubscribeFollowups?.();
      unsubscribeWebhooks?.();
      server.stop(true);
    },
  };
}

function handleSseRequest(
  request: Request,
  clients: Map<string, ReadableStreamDefaultController<Uint8Array>>,
  encoder: TextEncoder,
): Response {
  const clientId = randomUUID();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.set(clientId, controller);
      controller.enqueue(
        encodeSseEvent(
          encoder,
          'connected',
          {
            event_id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
          randomUUID(),
        ),
      );

      const pingTimer = setInterval(() => {
        try {
          controller.enqueue(encodeSseEvent(encoder, 'ping', { timestamp: new Date().toISOString() }));
        } catch {
          clients.delete(clientId);
          clearInterval(pingTimer);
        }
      }, 15_000);

      cleanup = () => {
        clients.delete(clientId);
        clearInterval(pingTimer);
        request.signal.removeEventListener('abort', cleanup);
        try {
          controller.close();
        } catch {
          // no-op
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}

function encodeSseEvent(encoder: TextEncoder, event: string, data: unknown, id?: string): Uint8Array {
  const lines: string[] = [];

  if (id) {
    lines.push(`id: ${id}`);
  }

  lines.push(`event: ${event}`);

  const jsonPayload = JSON.stringify(data);
  lines.push(`data: ${jsonPayload}`);
  lines.push('');

  return encoder.encode(`${lines.join('\n')}\n`);
}

function isAuthorized(request: Request, apiKey: string): boolean {
  const value = request.headers.get('authorization');
  if (!value) {
    return false;
  }

  return value === `Bearer ${apiKey}`;
}

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
  });
}

function rateLimitResponse(
  scope: 'ip' | 'agent_mutation' | 'sse_connect',
  result: { retryAfterSeconds: number; remainingTokens: number },
): Response {
  return json(
    {
      ok: false,
      error: 'rate_limited',
      scope,
      retry_after_seconds: result.retryAfterSeconds,
      remaining_tokens: result.remainingTokens,
    },
    429,
    {
      'Retry-After': String(result.retryAfterSeconds),
    },
  );
}

function claimMutationStatusCode(result: {
  ok: boolean;
  reason?: 'already_claimed' | 'claim_not_found' | 'invalid_transition' | 'agent_mismatch' | string;
}): number {
  if (result.ok) {
    return 200;
  }

  if (result.reason === 'claim_not_found') {
    return 404;
  }

  if (
    result.reason === 'agent_mismatch' ||
    result.reason === 'invalid_transition' ||
    result.reason === 'already_claimed'
  ) {
    return 409;
  }

  return 400;
}

function checkRateLimit(
  limiter: TokenBucketLimiter | undefined,
  key: string | undefined,
): { retryAfterSeconds: number; remainingTokens: number } | null {
  if (!limiter || !key) {
    return null;
  }

  const result = limiter.consume(key);
  if (result.allowed) {
    return null;
  }

  return {
    retryAfterSeconds: result.retryAfterSeconds,
    remainingTokens: result.remainingTokens,
  };
}

function checkMutationRateLimit(
  limiter: TokenBucketLimiter | undefined,
  principal: string | undefined,
  agentId: string | undefined,
): { retryAfterSeconds: number; remainingTokens: number } | null {
  const principalLimit = checkRateLimit(limiter, principal ? `principal:${principal}` : undefined);
  if (principalLimit) {
    return principalLimit;
  }

  return checkRateLimit(limiter, agentId ? `agent:${agentId}` : undefined);
}

function getMutationPrincipal(request: Request): string | undefined {
  const value = request.headers.get('authorization');
  if (!value || !value.trim()) {
    return undefined;
  }

  return value.trim();
}

function getClientIp(request: Request, server: Bun.Server<any>, trustProxy: boolean): string {
  if (trustProxy) {
    // Forwarded headers are safe only when a trusted proxy sanitizes them.
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor && forwardedFor.trim()) {
      const first = forwardedFor.split(',')[0]?.trim();
      if (first) {
        return first;
      }
    }

    const realIp = request.headers.get('x-real-ip');
    if (realIp && realIp.trim()) {
      return realIp.trim();
    }
  }

  const socketAddress = server.requestIP(request);
  if (socketAddress?.address) {
    return socketAddress.address;
  }

  return 'unknown';
}

async function parseJsonBody(
  request: Request,
  options: {
    optional?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  if (options.optional && request.headers.get('content-length') === '0') {
    return {};
  }

  const text = await request.text();
  if (!text.trim()) {
    if (options.optional) {
      return {};
    }
    throw new ClientInputError('Request body is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClientInputError('Invalid JSON payload');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClientInputError('Expected a JSON object payload');
  }

  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ClientInputError(`Missing or invalid field: ${key}`);
  }

  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  return value.trim();
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ClientInputError(`Missing or invalid field: ${key}`);
  }

  return value;
}

function optionalNumber(value: string | null): number | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function requireStatus(body: Record<string, unknown>, key: string): ClaimStatus {
  const value = body[key];
  const status = typeof value === 'string' ? value : '';
  const validStatuses: ClaimStatus[] = [
    'claimed',
    'in_progress',
    'pr_submitted',
    'pr_merged',
    'closed',
    'released',
    'stale',
  ];

  if (!validStatuses.includes(status as ClaimStatus)) {
    throw new ClientInputError(`Invalid claim status: ${String(value)}`);
  }

  return status as ClaimStatus;
}

function optionalStatus(value: string | null): ClaimStatus | undefined {
  if (!value) {
    return undefined;
  }

  const validStatuses: ClaimStatus[] = [
    'claimed',
    'in_progress',
    'pr_submitted',
    'pr_merged',
    'closed',
    'released',
    'stale',
  ];

  return validStatuses.includes(value as ClaimStatus) ? (value as ClaimStatus) : undefined;
}

function requireFollowupStatus(body: Record<string, unknown>, key: string): FollowupStatus {
  const value = body[key];
  const status = typeof value === 'string' ? value : '';
  const validStatuses: FollowupStatus[] = ['queued', 'claimed', 'in_progress', 'done', 'dismissed', 'stale'];

  if (!validStatuses.includes(status as FollowupStatus)) {
    throw new ClientInputError(`Invalid follow-up status: ${String(value)}`);
  }

  return status as FollowupStatus;
}

function optionalFollowupStatus(value: string | null): FollowupStatus | undefined {
  if (!value) {
    return undefined;
  }

  const validStatuses: FollowupStatus[] = ['queued', 'claimed', 'in_progress', 'done', 'dismissed', 'stale'];
  return validStatuses.includes(value as FollowupStatus) ? (value as FollowupStatus) : undefined;
}
