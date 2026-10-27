import type {
  ApiError,
  CreateSessionRequest,
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  HubOperation,
  InteractionKey,
  InternalDetailQuery,
  InternalDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionListQuery,
  SessionListResponse,
  SessionUpdatesQuery,
  SessionUpdatesResponse,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract";
import type { UploadAttachment } from "../../shared/uploads";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
    signal,
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // The API normally returns JSON, but the client still fails safely if a proxy does not.
    }
    const apiError = parseApiError(body);
    throw new ApiClientError(
      response.status,
      apiError?.code ?? "request_failed",
      apiError?.message ?? `Request failed (${response.status})`,
    );
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseApiError(value: unknown): ApiError["error"] | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error !== "object" || error === null) return null;
  if (!("code" in error) || typeof error.code !== "string") return null;
  if (!("message" in error) || typeof error.message !== "string") return null;
  return { code: error.code, message: error.message };
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const api = {
  upload: (file: File, signal: AbortSignal, sessionId: string) =>
    request<UploadAttachment>(
      `/api/v1/uploads?sessionId=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(file.name)}`,
      signal,
      {
        method: "POST",
        body: file,
      },
    ),
  uploads: (id: string, signal: AbortSignal) =>
    request<{ items: UploadAttachment[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/uploads`,
      signal,
    ),
  deleteUpload: (id: string, attachmentId: string, signal: AbortSignal) =>
    request<{ deleted: boolean }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/uploads/${encodeURIComponent(attachmentId)}`,
      signal,
      { method: "DELETE" },
    ),
  createSession: (input: CreateSessionRequest) => postJson<HubOperation>("/api/v1/sessions", input),
  exitSession: (id: string) =>
    postJson<HubOperation>(`/api/v1/sessions/${encodeURIComponent(id)}/exit`, {}),
  archiveSession: (id: string) =>
    postJson<HubOperation>(`/api/v1/sessions/${encodeURIComponent(id)}/archive`, {}),
  deleteSession: (id: string) =>
    request<HubOperation>(`/api/v1/sessions/${encodeURIComponent(id)}`, undefined, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  operation: (id: string, signal?: AbortSignal) =>
    request<HubOperation>(`/api/v1/operations/${encodeURIComponent(id)}`, signal),
  sessions: (query: SessionListQuery, signal?: AbortSignal) =>
    request<SessionListResponse | null>(
      `/api/v1/sessions${queryString({ after: query.after })}`,
      signal,
    ).then((value) => value ?? null),
  items: (id: string, query: ItemPageQuery, signal?: AbortSignal) =>
    request<ItemPageResponse>(
      `/api/v1/sessions/${encodeURIComponent(id)}/items${queryString({
        limit: query.limit,
        cursor: query.cursor,
      })}`,
      signal,
    ),
  updates: (id: string, query: SessionUpdatesQuery, signal?: AbortSignal) =>
    request<SessionUpdatesResponse | null>(
      `/api/v1/sessions/${encodeURIComponent(id)}/updates${queryString({
        cursor: query.cursor,
        after: query.after,
      })}`,
      signal,
    ).then((value) => value ?? null),
  tool: (sessionId: string, itemId: string, query: ToolDetailQuery, signal?: AbortSignal) =>
    request<ToolDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/tool${queryString({ cursor: query.cursor })}`,
      signal,
    ),
  directive: (
    sessionId: string,
    itemId: string,
    query: DirectiveDetailQuery,
    signal?: AbortSignal,
  ) =>
    request<DirectiveDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/directive${queryString({ cursor: query.cursor })}`,
      signal,
    ),
  internal: (sessionId: string, itemId: string, query: InternalDetailQuery, signal?: AbortSignal) =>
    request<InternalDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/internal${queryString({ cursor: query.cursor })}`,
      signal,
    ),
  sendMessage: (sessionId: string, message: string, signal?: AbortSignal) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { message },
      signal,
    ),
  handoffPaneBinding: (sessionId: string, signal?: AbortSignal) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/handoff-pane-binding`,
      {},
      signal,
    ),
  sendKeys: (sessionId: string, keys: readonly InteractionKey[], signal?: AbortSignal) =>
    postJson<void>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/keys`, { keys }, signal),
};
