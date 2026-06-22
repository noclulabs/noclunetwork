// The response envelope every route renders. Routes parse and delegate, then
// return one of these shapes. Keep this in sync with the OpenAPI schemas.

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorBody;
  pagination?: Pagination;
}

export function ok<T>(data: T, pagination?: Pagination): ApiResponse<T> {
  const body: ApiResponse<T> = { success: true, data };
  if (pagination) {
    body.pagination = pagination;
  }
  return body;
}

export function fail(code: string, message: string): ApiResponse<never> {
  return { success: false, error: { code, message } };
}
