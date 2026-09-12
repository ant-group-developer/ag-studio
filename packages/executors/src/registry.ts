import { HarnessError, type Executor, type ExecutorRef } from "@harness/contracts";

export class ExecutorRegistry {
  private readonly byKind = new Map<ExecutorRef["type"], Executor>();
  register(kind: ExecutorRef["type"], executor: Executor): void { this.byKind.set(kind, executor); }
  resolve(ref: ExecutorRef): Executor {
    const ex = this.byKind.get(ref.type);
    if (!ex) throw new HarnessError("NOT_FOUND", `no executor registered for kind "${ref.type}"`, { kind: ref.type });
    return ex;
  }
}
