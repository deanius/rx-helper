import { Observable, Subscription, Subscribable } from "rxjs";
import { HandlerConfig } from "./types";
/**
 * Options that get mixed into the agent as read-only
 * properties upon construction. Whitelisted to: agentId
 */
export interface AgentConfig {
    /**
     * Any value: One Suggestion is hex digits (a4ad3d) but
     * the way you'll create this will depend on your environment.
     */
    agentId?: any;
    [key: string]: any;
}
/**
 * The core of the Rx-Helper Agent API: methods to add subscribers (filters or handlers)
 * and a single method to 'dispatch' an event (Flux Standard Action) to relevant subscribers.
 */
export interface Evented {
    process(event: Event, context?: Object): ProcessResult;
    subscribe(event$: Observable<Event>, context?: Object): Subscription;
    filter(eventMatcher: EventMatcher, handler: Subscriber, config?: HandlerConfig): Subscription;
    on(eventMatcher: EventMatcher, handler: Subscriber, config?: HandlerConfig): Subscription;
}
/**
 * A subscriber is either a handler or a filter - a function which
 * receives as its argument the EventedItem, typically to use
 * the payload of the `event` property to cause some side-effect.
 */
export declare type Subscriber = Filter | Handler;
/**
 * An object conforming to the Flux Standard Action specification
 */
export interface Event {
    type: string;
    payload?: any;
    error?: boolean;
    meta?: Object;
}
export interface EventedItem {
    /** The event which caused a filter/handler to be run */
    event: Event;
    /** The type of the event */
    type?: string;
    payload?: any;
    /** The payload of the event */
    /** An optional object, like the websocket or http response
     * that this event arrived on, on which its processing may
     * make function calls (such as res.write())
     */
    context?: Object;
    /** The results of filters, keyed by their name */
    results?: Map<string, any>;
}
/**
 * When a handler (async usually) returns an Observable, it's possible
 * that another handler for that type is running already (see demo 'speak-up').
 * The options are:
 * - parallel: Concurrent handlers are unlimited, unadjusted
 * - serial: Concurrency of 1, handlers are queued
 * - cutoff: Concurrency of 1, any existing handler is killed
 * - mute: Concurrency of 1, existing handler prevents new handlers
 * - toggle: Concurrency of 1, kill existing, otherwise start anew
 *
 * ![concurrency modes](https://s3.amazonaws.com/www.deanius.com/ConcurModes2.png)
 */
export declare enum Concurrency {
    /**
     * Handlers are invoked on-demand - no limits */
    parallel = "parallel",
    /**
     * Concurrency of 1, handlers are queued */
    serial = "serial",
    /**
     * Concurrency of 1, any existing handler is killed */
    cutoff = "cutoff",
    /**
     * Concurrency of 1, existing handler prevents new handlers */
    mute = "mute",
    /**
     * Concurrency of 1, existing handler is canceled, and prevents new handlers */
    toggle = "toggle"
}
/**
 * The function you assign to handle `.on(eventType)`
 * events is known as a Handler. It receives as arguments
 * 1) An object containing an event (aka event), and context as fields
 * 2) The event's payload as a 2nd parameter (This makes
 *    referring to the payload easy, and is actually similar to JQuery ha!)
 */
export interface Handler {
    (item: EventedItem, payload?: any): any;
}
/**
 * A Filter runs a synchronous function prior to any handlers
 * being invoked, and can cancel future filters, and all handlers
 * by throwing an exception, which must be caught by the caller of
 * `process(event)`.
 *
 * It does *not*, as its name suggest, split off a slice of the
 * stream. To do that see `getAllEvents`.
 * @see getAllEvents
 */
export interface Filter {
    (item: EventedItem, payload?: any): any;
}
export interface HandlerConfig {
    /** A name by which the results will be keyed. Example: `agent.process(event).completed.NAME.then(() => ...)` */
    name?: string;
    /** The concurrency mode to use. Governs what happens when another handling from this handler is already in progress. */
    mode?: Concurrency;
    /** Alias for `mode`. */
    concurrency?: Concurrency;
    /** If true, the Observable returned by the handler will be fed to `agent.subscribe`, so its events are `process`ed. */
    processResults?: Boolean;
    /** If provided, this handlers' Observables values will be wrapped in FSAs with this type. */
    type?: string;
    /** Alias for `type`. */
    triggerAs?: string;
    /** If provided, this will be called if a mode (cutoff, toggle) terminates a handling. Parameter is {event}. */
    onCutoff?: Subscriber;
    /** If provided, the context of the event being responded to will be forwarded */
    withContext?: Boolean;
}
export interface SubscribeConfig {
    /** If provided, this handlers' Observables values will be wrapped in FSAs with this type. */
    type?: string;
    /** Alias for `type`. */
    triggerAs?: string;
    /** If provided, this will be the context argument for each processed event */
    context?: any;
}
export declare type EventMatcher = string | string[] | RegExp | Predicate | boolean;
export interface Predicate {
    (item: EventedItem): boolean;
}
/**
 * The return value from calling `process`/`trigger`.
 * Basically this is the event that was passed to `process`,
 * but extended with the return values of filters (under their name).
 */
export interface ProcessResult extends Event {
    [key: string]: any;
}
/**
 * Options are typical from rxjs/ajax, however the expandKey string
 * is one corresponding to an OboeJS node matcher, or a sub-key, depending on whether
 * the `lib` option is set to "oboe" or "rxjs". Oboe is used if present in the global
 * namespace, and lib is not set to `rxjs`.
 */
export interface StreamingGetOptions {
    url: string;
    /** If an RxJS request, you can provide a key of an array field to turn its items into your notifications. If an Oboe request see: http://oboejs.com/api#pattern-matching */
    expandKey?: string;
    method?: "GET" | "POST";
    headers?: Object;
    body?: string | Object;
    withCredentials?: Boolean;
    timeout?: number;
    /** Defaults to `oboe` if global `oboe` is present, otherwise uses `rxjs` */
    lib?: "rxjs" | "oboe";
}
/**
 * An object duck-typing a Redux store.
 */
export interface StoreLike {
    dispatch(event: any): any;
    getState(): any;
}
export interface AwaitableObservable extends PromiseLike<any>, Subscribable<any> {
}
