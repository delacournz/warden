export type SuccessResult<Success> = { success: true; data: Success };
export type ErrorResult<Error = string> = { success: false; error: Error };
export type Result<Success, Error = string> = SuccessResult<Success> | ErrorResult<Error>;
export type AsyncResult<Success, Error = string> = Promise<Result<Success, Error>>;

export function ok<T>(data: T): SuccessResult<T> {
	return { success: true, data };
}

export function err(error: unknown): ErrorResult<string> {
	return {
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}
