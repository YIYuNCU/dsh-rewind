declare module '@deepseek-ai/cordis' {
  interface Logger {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }

  export interface Context {
    logger: Logger
    effect(setup: () => void | (() => void), label?: string): void
    provide(name: string, value: unknown): void
    inject(names: readonly string[], plugin: (ctx: Context) => void): void
    // Cordis event payloads are declared by each plugin; this shim cannot name them.
    on(name: string, listener: (...args: any[]) => unknown, options?: { readonly prepend?: boolean }): () => void
    get(name: string): unknown
    webServer: {
      register(route: { readonly kind: 'exact'; readonly path: string; handler: (request: unknown, response: unknown) => Promise<void> }): () => void
    }
    sessions: { get(id: string): unknown }
    sessionQuery: { readSession(id: string): Promise<unknown> }
    agents: { list(): readonly unknown[] }
    settings?: unknown
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    default(value: any): this
    step(value: number): this
    min(value: number): this
    max(value: number): this
    volatile(): this
  }

  interface Schemastery {
    object<T>(fields: Record<string, Schema>): Schema<T>
    number(): Schema<number>
    string(): Schema<string>
    boolean(): Schema<boolean>
    union(values: readonly string[]): Schema<string>
  }

  const z: Schemastery
  export default z
}

declare module '@deepseek-ai/dsh-settings' {
  export interface SettingsProvider {
    register?<T>(namespace: string, schema: unknown, options?: { readonly base?: Partial<T> }): unknown
    installSection?<T>(owner: unknown, namespace: string, schema: unknown, entry: T, hooks: unknown): void
  }
}
