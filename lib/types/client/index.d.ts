/**
 * Browser half of DSH Rewind.
 * The turn-tail slot is the supported mount. A future user-message slot is registered the same way.
 */
import { type ReactNode } from 'react';
interface ClientContext {
    effect(setup: () => void | (() => void), label?: string): void;
    on?(name: string, listener: (snapshot: {
        readonly active?: string;
    }) => void): unknown;
    get?(name: string): unknown;
    slots: {
        inject(name: string, install: () => void): void;
        register(entry: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode): void;
    };
    sessions: {
        open?(id: string): void;
        scope(id: string): unknown;
    };
    conversation: {
        input: {
            for(scope: unknown): {
                setDraft(text: string): void;
            };
        };
    };
}
/** Services this browser plugin reads. */
export declare const inject: string[];
/**
 * Register the turn-tail action and the settings card.
 * @param ctx - Client context. This plugin does not start a server.
 */
export declare function apply(ctx: ClientContext): void;
export {};
