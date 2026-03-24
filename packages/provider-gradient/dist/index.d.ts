import type { ModelCapabilityProfile, ProviderClient, ProviderRequest, ProviderStreamHandlers, ProviderTurn } from "@gradient-code/shared";
type GradientClientOptions = {
    baseUrl?: string;
    apiKey: string;
    retryCount?: number;
    onDebug?: (message: string) => void;
};
export type GradientModelOption = {
    id: string;
    label: string;
    family: string;
};
export declare const AVAILABLE_GRADIENT_MODELS: GradientModelOption[];
export declare function normalizeProviderModelName(model: string): string;
export declare function resolveModelCapabilityProfile(model: string): ModelCapabilityProfile;
export declare class GradientChatCompletionsClient implements ProviderClient {
    private readonly baseUrl;
    private readonly apiKey;
    private readonly retryCount;
    private readonly onDebug?;
    constructor(options: GradientClientOptions);
    private endpointUrl;
    private requestHeaders;
    private fetchWithRetry;
    private streamWithRetry;
    private createTurnWithEndpoint;
    createTurn(request: ProviderRequest): Promise<ProviderTurn>;
    createTurnStream(request: ProviderRequest, handlers: ProviderStreamHandlers): Promise<ProviderTurn>;
}
export declare const GradientResponsesClient: typeof GradientChatCompletionsClient;
export {};
