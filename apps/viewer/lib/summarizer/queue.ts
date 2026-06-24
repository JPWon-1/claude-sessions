export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => job(), () => job());
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }
}
