import { ApiError } from '../api.js';
export function errorInfo(error: unknown): { status: number; code: string; userMessage: string } {
  if (error instanceof ApiError) return error;
  return {
    status: 0,
    code: 'UNKNOWN_ERROR',
    userMessage: 'Не удалось выполнить действие. Проверьте соединение и повторите попытку.',
  };
}
export const errorMessage = (error: unknown) => errorInfo(error).userMessage;
