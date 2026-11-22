export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const NETWORK_ERROR = 'Cannot reach the Jiraffe server. Showing the last loaded data.';

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiRequestError(NETWORK_ERROR);
  }
  if (!res.ok) {
    let message = `The server returned an error (HTTP ${res.status}).`;
    let field: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: { message?: string; field?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      field = parsed.error?.field;
    } catch {
      // keep the generic message
    }
    throw new ApiRequestError(message, field);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
