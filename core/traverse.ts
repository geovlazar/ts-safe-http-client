import * as enh from "./enhance.ts";

// TODO: add option to apply random user agent to HTTP header
// TODO: add file downloads and other functions from uniform-resource

export type RequestInfoEnhancer = enh.EnhancerSync<
  TraverseContext,
  RequestInfo
>;

export class RemoveUrlTrackingCodes implements RequestInfoEnhancer {
  static readonly singleton = new RemoveUrlTrackingCodes();
  static readonly pattern = /(?<=&|\?)utm_.*?(&|$)/igm;

  enhance(_: TraverseContext, request: RequestInfo): RequestInfo {
    if (typeof request === "string") {
      return request.replace(RemoveUrlTrackingCodes.pattern, "");
    }
    return request;
  }
}

export interface Requestable {
  readonly request: RequestInfo;
  readonly requestInit?: RequestInit;
}

export interface Labelable {
  readonly label?: string;
}

export interface TraverseContext extends Requestable, Labelable {
  readonly parent?: TraverseContext;
  readonly options: TraverseOptions;
}

export interface TraverseOptions {
  readonly trEnhancer: TraversalResultEnhancer;
  readonly riEnhancer?: RequestInfoEnhancer;
}

export interface TraversalResult extends Requestable, Labelable {
  readonly isTraversalResult: true;
}

export type TraversalResultEnhancer = enh.Enhancer<
  TraverseContext,
  TraversalResult
>;

export interface TransformedTraversalResult extends TraversalResult {
  readonly transformedFrom: TraversalResult;
  readonly position: number;
  readonly remarks?: string;
}

export function isTransformedTraversalResult(
  o: unknown,
): o is TransformedTraversalResult {
  return o && typeof o === "object" &&
    ("transformedFrom" in o && "position" in o);
}

export function nextTransformationPosition(
  o: TraversalResult,
): number {
  return isTransformedTraversalResult(o) ? o.position + 1 : 0;
}

export interface UnsuccessfulTraversal extends TraversalResult {
  readonly error: Error;
}

export interface SuccessfulTraversal extends TraversalResult {
  readonly response: Response;
  readonly terminalURL: string;
}

export interface InvalidHttpStatus extends SuccessfulTraversal {
  readonly invalidHttpStatus: number;
}

export function isInvalidHttpStatus(
  o: TraversalResult,
): o is InvalidHttpStatus {
  return "invalidHttpStatus" in o;
}

export interface TraversalContent extends SuccessfulTraversal {
  readonly httpStatus: number;
  readonly contentType: string;
}

export function isTraversalContent(
  o: TraversalResult,
): o is TraversalContent {
  return "httpStatus" in o && "contentType" in o;
}

export type TraversalContentEnhancer = enh.Enhancer<
  TraverseContext,
  TraversalContent
>;

export interface TraversalStructuredContent extends TraversalContent {
  readonly isStructuredContent: boolean;
}

export function isTraversalStructuredContent(
  o: TraversalResult,
): o is TraversalStructuredContent {
  return "isStructuredContent" in o;
}

export interface TraversalJsonContent<T> extends TraversalStructuredContent {
  readonly jsonInstance: T;
  readonly guard?: DetectJsonContentGuard<T>;
  readonly onGuardFailure?: DetectJsonContentGuardFailure<T>;
}

export function isTraversalJsonContent<T>(
  o: TraversalResult,
): o is TraversalJsonContent<T> {
  return "jsonInstance" in o;
}

export interface TraversalTextContent extends TraversalContent {
  readonly isHtmlContent: boolean;
  readonly bodyText: string;
}

export function isTraversalTextContent(
  o: TraversalResult,
): o is TraversalTextContent {
  return "bodyText" in o;
}

export interface TraversalContentRedirect extends TransformedTraversalResult {
  readonly contentRedirectUrl: string;
}

export function isTraversalRedirect(
  o: TraversalResult,
): o is TraversalContentRedirect {
  return "contentRedirectUrl" in o;
}

export class RemoveLabelLineBreaksAndTrimSpaces
  implements TraversalResultEnhancer {
  static readonly singleton = new RemoveLabelLineBreaksAndTrimSpaces();

  async enhance(
    _: TraverseContext,
    instance: SuccessfulTraversal,
  ): Promise<SuccessfulTraversal | TransformedTraversalResult> {
    if (!instance.label) {
      return instance;
    }

    const cleanLabel = instance.label.replace(/\r\n|\n|\r/gm, " ").trim();
    if (cleanLabel != instance.label) {
      const result: TransformedTraversalResult = {
        ...instance,
        transformedFrom: instance,
        label: cleanLabel,
        position: nextTransformationPosition(instance),
        remarks: "Removed line breaks and trimmed spaces in label",
      };
      return result;
    }
    return instance;
  }
}

export class ValidateStatus implements TraversalResultEnhancer {
  static readonly singleton = new ValidateStatus();

  async enhance(
    ctx: TraverseContext,
    instance: SuccessfulTraversal,
  ): Promise<TraversalContent | InvalidHttpStatus> {
    if (
      isTraversalContent(instance) ||
      isInvalidHttpStatus(instance)
    ) {
      return instance;
    }

    if (instance.response.status == 200) {
      const contentType = instance.response.headers.get("Content-Type");
      const result: TraversalContent = {
        ...instance,
        httpStatus: instance.response.status,
        contentType: contentType ? contentType.trim() : "",
      };
      return result;
    }

    const result: InvalidHttpStatus = {
      ...instance,
      invalidHttpStatus: instance.response.status,
    };
    return result;
  }
}

export class DetectTextContent implements TraversalResultEnhancer {
  static readonly singleton = new DetectTextContent();

  isProperContentType(instance: TraversalContent): boolean {
    return instance.contentType.startsWith("text/");
  }

  async enhance(
    ctx: TraverseContext,
    instance: SuccessfulTraversal,
  ): Promise<SuccessfulTraversal | TraversalTextContent> {
    instance = await ValidateStatus.singleton.enhance(ctx, instance);
    if (isTraversalTextContent(instance)) return instance;
    if (isTraversalContent(instance)) {
      if (this.isProperContentType(instance)) {
        const bodyText = await instance.response.text();
        const textContent: TraversalTextContent = {
          ...instance,
          bodyText: bodyText,
          isHtmlContent: instance.contentType.startsWith("text/html"),
        };
        return textContent;
      }
    }
    return instance;
  }
}

export interface DetectJsonContentGuard<T> {
  (o: unknown, instance: SuccessfulTraversal): o is T;
}

export interface DetectJsonContentGuardFailure<T> {
  (instance: SuccessfulTraversal): T | undefined;
}

export class DetectJsonContent<T> implements TraversalResultEnhancer {
  constructor(
    readonly guard?: DetectJsonContentGuard<T>,
    readonly onGuardFailure?: DetectJsonContentGuardFailure<T>,
  ) {
  }

  isProperContentType(instance: TraversalContent): boolean {
    return instance.contentType.startsWith("application/json");
  }

  async enhance(
    ctx: TraverseContext,
    instance: SuccessfulTraversal,
  ): Promise<SuccessfulTraversal | TraversalTextContent> {
    instance = await ValidateStatus.singleton.enhance(ctx, instance);
    if (isTraversalJsonContent(instance)) return instance;
    if (isTraversalContent(instance)) {
      if (this.isProperContentType(instance)) {
        const textContent: TraversalJsonContent<T> = {
          ...instance,
          isStructuredContent: true,
          jsonInstance: await instance.response.json(),
          guard: this.guard,
          onGuardFailure: this.onGuardFailure,
        };
        return textContent;
      }
    }
    return instance;
  }
}
export class DetectMetaRefreshRedirect implements TraversalResultEnhancer {
  static readonly singleton = new DetectMetaRefreshRedirect();

  constructor(
    readonly metaRefreshPattern =
      "(CONTENT|content)=[\"']0;[ ]*(URL|url)=(.*?)([\"']\s*>)",
  ) {
  }

  extractMetaRefreshUrl(html: string): string | null {
    let match = html.match(this.metaRefreshPattern);
    return match && match.length == 5 ? match[3] : null;
  }

  async enhance(
    ctx: TraverseContext,
    instance: SuccessfulTraversal,
  ): Promise<
    SuccessfulTraversal | TraversalContentRedirect | TraversalTextContent
  > {
    instance = await DetectTextContent.singleton.enhance(ctx, instance);
    if (isTraversalTextContent(instance) && instance.isHtmlContent) {
      const contentRedirectUrl = this.extractMetaRefreshUrl(instance.bodyText);
      if (contentRedirectUrl) {
        const redirected = await traverse(
          { ...ctx, request: contentRedirectUrl, parent: ctx },
        );
        const result: TraversalContentRedirect = {
          ...redirected,
          transformedFrom: instance,
          position: nextTransformationPosition(instance),
          remarks: `DetectMetaRefreshRedirect(${contentRedirectUrl})`,
          contentRedirectUrl,
        };
        return result;
      }
    }
    return instance;
  }
}

export class EnhanceContent implements TraversalResultEnhancer {
  constructor(readonly contentEnhancer: TraversalContentEnhancer) {
  }

  async enhance(
    ctx: TraverseContext,
    instance: SuccessfulTraversal,
  ): Promise<SuccessfulTraversal | TraversalContent> {
    if (isTraversalContent(instance)) {
      return await this.contentEnhancer.enhance(ctx, instance);
    }
    return instance;
  }
}

export function defaultTraverseOptions(
  override?: Partial<TraverseOptions> & {
    readonly contentEnhancers: TraversalContentEnhancer[];
  },
): TraverseOptions {
  return {
    trEnhancer: override?.trEnhancer ||
      enh.enhancer(
        RemoveLabelLineBreaksAndTrimSpaces.singleton,
        DetectMetaRefreshRedirect.singleton,
        new EnhanceContent(enh.enhancer(...(override?.contentEnhancers || []))),
      ),
    riEnhancer: override?.riEnhancer ||
      enh.enhancerSync(RemoveUrlTrackingCodes.singleton),
  };
}

export async function traverse(ctx: TraverseContext): Promise<TraversalResult> {
  const { request, requestInit, options, label } = ctx;
  try {
    const { trEnhancer, riEnhancer } = options;
    const response = await window.fetch(
      riEnhancer ? riEnhancer.enhance(ctx, request) : request,
      { ...requestInit, redirect: "follow" },
    );
    let start: SuccessfulTraversal = {
      isTraversalResult: true,
      response,
      request,
      requestInit,
      label,
      terminalURL: response.url,
    };
    const result = await trEnhancer.enhance(ctx, start);
    if (!response.bodyUsed) response.body?.cancel();
    return result;
  } catch (error) {
    const result: UnsuccessfulTraversal = {
      isTraversalResult: true,
      request,
      requestInit,
      label,
      error,
    };
    return result;
  }
}
