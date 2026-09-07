export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function notFound() {
  return new ApiError(404, "NOT_FOUND", "资源不存在或当前身份无权访问");
}
