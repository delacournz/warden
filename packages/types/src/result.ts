export type SuccessResult<Success> = { success: true; data: Success };
export type ErrorResult<Error = string> = { success: false; error: Error };
export type Result<Success, Error = string> = SuccessResult<Success> | ErrorResult<Error>;
export type AsyncResult<Success, Error = string> = Promise<Result<Success, Error>>;

/** Builds `Result` values. Use the shared {@link resultFactory} singleton. */
export class ResultFactory {
	ok<T>(data: T): SuccessResult<T> {
		return { success: true, data };
	}

	err(error: unknown): ErrorResult<string> {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export const resultFactory = new ResultFactory();
