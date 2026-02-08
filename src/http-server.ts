import { randomUUID } from 'node:crypto';
import { ClaimManager } from './claim-manager';
import { Logger } from './logger';
import { SyncService } from './sync';
import { AppConfig, ClaimEvent, ClaimStatus } from './types';
import { IssueCommandService } from './issuecommand-service';

interface HttpServerOptions {
  service: IssueCommandService;
  claims: ClaimManager;
  sync: SyncService;
  config: AppConfig;
  logger: Logger;
}

interface RunningHttpServer {
  stop: () => void;
  port: number;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export function startHttpServer(options: HttpServerOptions): RunningHttpServer {
  const sseClients = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

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

  const server = Bun.serve({
    port: options.config.httpPort,
    fetch: async (request) => {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if ((pathname.startsWith('/api') || pathname === '/sse') && !isAuthorized(request, options.config.apiKey)) {
        return json(
          {
            ok: false,
            error: 'unauthorized',
          },
          401,
        );
      }

      if (request.method === 'GET' && pathname === '/sse') {
        return handleSseRequest(request, sseClients, encoder);
      }

      try {
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
          const response = await options.service.claimIssue({
            agent_id: requireString(body, 'agent_id'),
            repo: requireString(body, 'repo'),
            issue_number: requireNumber(body, 'issue_number'),
          });
          return json(response, response.ok ? 200 : 409);
        }

        const claimPathMatch = pathname.match(/^\/api\/claims\/([^/]+)$/);
        if (claimPathMatch && request.method === 'DELETE') {
          const claimId = claimPathMatch[1];
          const body = await parseJsonBody(request, { optional: true });

          const response = await options.service.releaseIssue({
            claim_id: claimId,
            agent_id: optionalString(body, 'agent_id'),
            reason: optionalString(body, 'reason'),
          });

          return json(response, response.ok ? 200 : 404);
        }

        if (claimPathMatch && request.method === 'PATCH') {
          const claimId = claimPathMatch[1];
          const body = await parseJsonBody(request);

          const response = await options.service.updateClaimStatus({
            claim_id: claimId,
            status: requireStatus(body, 'status'),
            note: optionalString(body, 'note'),
            pr_url: optionalString(body, 'pr_url'),
          });

          return json(response, response.ok ? 200 : 400);
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
        options.logger.error('http.request_failed', {
          method: request.method,
          path: pathname,
          message: error instanceof Error ? error.message : String(error),
        });

        return json(
          {
            ok: false,
            error: 'request_failed',
            message: error instanceof Error ? error.message : String(error),
          },
          400,
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
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
    throw new Error('Request body is required');
  }

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object payload');
  }

  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing or invalid field: ${key}`);
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
    throw new Error(`Missing or invalid field: ${key}`);
  }

  return value;
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
    throw new Error(`Invalid claim status: ${String(value)}`);
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
