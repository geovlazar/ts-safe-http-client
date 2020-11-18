import {
  git,
  inspect as insp,
  managedGit as mGit,
  safeHttpClient as shc,
  urlcat,
  vault as v,
} from "./deps.ts";
import * as gls from "./gitlab-schema.ts";

export interface GitLabApiCallPreparer {
  (
    pathTemplate: string,
    params?: urlcat.ParamMap,
  ): string;
}

export type GitLabHostname = string;
export type GitLabGroupID = string;
export type GitLabRepoID = string;
export type GitLabRepoURL = string;

export interface GitLabServerAuthn {
  readonly userName: v.VaultAttr;
  readonly accessToken: v.VaultAttr;
}

export class GitLabAuthnEnvVault {
  readonly vault: v.EnvironmentVault;

  constructor(vault?: v.EnvironmentVault) {
    this.vault = vault ||
      new v.EnvironmentVault(
        { commonNamespace: "GITLAB_", secretsNamespace: "GITLAB_SECRET_" },
      );
  }

  userName(hostID: string, defaultUser?: string): v.VaultAttr {
    return this.vault.defineEnvVar(
      `${hostID}_USER`,
      { defaultValue: defaultUser },
    );
  }

  accessToken(hostID: string, defaultToken?: string): v.VaultAttr {
    return this.vault.defineEnvVar(
      `${hostID}_TOKEN`,
      { defaultValue: defaultToken, isSecret: true },
    );
  }

  hostName(hostID: string, defaultHost?: string): GitLabHostname {
    const serverHostEnvVarName = this.vault.defineEnvVar(
      `${hostID}_HOST`,
      { defaultValue: defaultHost },
    );
    return serverHostEnvVarName.value() as string;
  }

  isServerConfigAvailable(hostID: string, defaultHostName?: string): boolean {
    const hostName = this.hostName(hostID, defaultHostName);
    const userName = this.userName(hostID).value();
    const accessToken = this.accessToken(hostID).value();
    return hostName && userName && accessToken ? true : false;
  }

  server(hostID: string, defaultHostName?: string): GitLabServer | undefined {
    const hostName = this.hostName(hostID, defaultHostName);
    const userName = this.userName(hostID);
    const accessToken = this.accessToken(hostID);
    if (hostName && userName.value() && accessToken.value()) {
      return {
        host: hostName,
        authn: { userName, accessToken },
      };
    }
    return undefined;
  }
}

export interface GitLabServer {
  readonly authn: GitLabServerAuthn;
  readonly host: GitLabHostname;
}

export interface GitLabRepoIdentity extends mGit.ManagedGitRepoIdentity {
  readonly group: GitLabGroupID;
  readonly repo: GitLabRepoID;
}

export interface GitLabHttpClientContext
  extends mGit.ManagedGitRepoEndpointContext {
  requestInit: RequestInit;
}

export interface GitLabRepoHttpClientContext extends GitLabHttpClientContext {
  readonly repo: GitLabRepo;
}

export interface GitLabGroupPopulateOptions {
  readonly populateGroup: true;
  readonly populateLabels: boolean;
}

// export interface GitLabStructComponentsPopulatorContext
//   extends mGit.GitManagerStructComponentsPopulatorContext {
//   readonly manager: GitLab;
//   readonly filterGroups?: (
//     group: gls.GitLabGroup,
//   ) => GitLabGroupPopulateOptions | false;
// }

// export const isGitLabStructComponentsPopulatorContext = safety.typeGuardCustom<
//   mGit.GitManagerStructComponentsPopulatorContext,
//   GitLabStructComponentsPopulatorContext
// >("manager");

// export function defaultGitLabStructComponentsPopulatorContext(
//   manager: GitLab,
// ): GitLabStructComponentsPopulatorContext {
//   return {
//     isGitManagerStructComponentsPopulatorContext: true,
//     manager: manager,
//     populator: PopulateTopLevelGroups.singleton,
//   };
// }

export function gitLabGroupsPopulator(
  manager: GitLab,
  filterGroups?: (
    group: gls.GitLabGroup,
  ) => GitLabGroupPopulateOptions | false,
): insp.Inspector<GitLabStructure> {
  return async (
    target:
      | GitLabStructure
      | insp.InspectionResult<GitLabStructure>,
  ): Promise<
    | GitLabStructure
    | insp.InspectionResult<GitLabStructure>
  > => {
    const instance = insp.inspectionTarget(target);
    const apiClientCtx = manager.apiClientContext(
      manager.managerApiURL("groups", { top_level_only: true }),
    );
    const groups = await shc.safeFetchJSON<gls.GitLabGroups>(
      apiClientCtx,
      shc.jsonContentInspector(gls.isGitLabGroups),
    );
    if (groups) {
      for (const group of groups) {
        let gpo: GitLabGroupPopulateOptions | false = false;
        if (filterGroups) {
          gpo = filterGroups(group);
          if (!gpo) continue;
        }
        instance.components.push(new GitLabStructComponent(group));
      }
    }
    return target;
  };
}

// export class PopulateTopLevelGroups
//   implements mGit.GitStructComponentsPopulator {
//   static readonly singleton = new PopulateTopLevelGroups();

//   async enhance(
//     ctx: mGit.GitManagerStructComponentsPopulatorContext,
//     instance: mGit.GitManagerStructComponentsSupplier,
//   ): Promise<mGit.GitManagerStructComponentsSupplier> {
//     if (isGitLabStructComponentsPopulatorContext(ctx)) {
//       const apiClientCtx = ctx.manager.apiClientContext(
//         ctx.manager.managerApiURL("groups", { top_level_only: true }),
//         shc.jsonTraverseOptions<gls.GitLabGroups>(
//           { guard: gls.isGitLabGroups },
//         ),
//       );
//       const groups = await shc.safeFetchJSON<gls.GitLabGroups>(
//         apiClientCtx,
//       );
//       if (groups) {
//         for (const group of groups) {
//           let gpo: GitLabGroupPopulateOptions | false = false;
//           if (ctx.filterGroups) {
//             gpo = ctx.filterGroups(group);
//             if (!gpo) continue;
//           }
//           const component = new GitLabStructComponent(group);
//           instance.components.push(component);
//         }
//       }
//     }
//     return instance;
//   }
// }

export class GitLabStructComponent
  implements mGit.GitManagerHierarchicalComponent {
  protected populated: boolean;
  protected subGroups: GitLabStructComponent[] = [];

  constructor(
    readonly group: gls.GitLabGroup,
    readonly level: number = 0,
    readonly parentGroup?: GitLabStructComponent,
  ) {
    this.populated = false;
  }

  get name(): string {
    return this.group.name;
  }

  get components(): GitLabStructComponent[] {
    return this.subGroups;
  }

  get parent(): GitLabStructComponent | undefined {
    return this.parentGroup;
  }

  get isTopLevel(): boolean {
    return this.level == 0;
  }

  get hasChildren(): boolean {
    return this.components.length > 0;
  }
}

export class GitLabStructure implements mGit.GitManagerStructure {
  protected groupsFetch: shc.SafeFetchJSON<gls.GitLabGroups>;
  protected populated: boolean;
  protected groups: GitLabStructComponent[] = [];

  constructor(readonly manager: GitLab) {
    this.groupsFetch = shc.safeFetchJSON;
    this.populated = false;
  }

  get components(): GitLabStructComponent[] {
    return this.groups;
  }
}

export class GitLab
  implements mGit.GitManager<GitLabStructure, GitLabRepoIdentity, GitLabRepo> {
  readonly topLevelgroupsPopulator = gitLabGroupsPopulator(this);

  constructor(readonly server: GitLabServer) {
  }

  apiRequestInit(): RequestInit {
    const authn = this.server.authn.accessToken.value();
    return {
      headers: {
        "PRIVATE-TOKEN": (authn as string) || "accessToken?",
      },
    };
  }

  apiClientContext(
    request: RequestInfo,
    options?: shc.TraverseOptions,
  ): GitLabHttpClientContext {
    return {
      isManagedGitRepoEndpointContext: true,
      request: request,
      requestInit: this.apiRequestInit(),
      options: options || shc.defaultTraverseOptions(),
    };
  }

  managerApiURL(
    pathTemplate: string,
    params?: urlcat.ParamMap,
  ): string {
    return urlcat.default(
      `https://${this.server.host}/api/v4`,
      pathTemplate,
      { ...params },
    );
  }

  async structure(): Promise<mGit.GitManagerStructure> {
    const populated = await this.topLevelgroupsPopulator(
      new GitLabStructure(this),
    );
    return insp.inspectionTarget(populated);
  }

  repo(identity: GitLabRepoIdentity): GitLabRepo {
    return new GitLabRepo(this, identity);
  }

  async repos(
    ctx: mGit.ManagedGitReposContext<GitLabRepo, void>,
  ): Promise<void> {
    throw new Error("Not implemented yet");
  }
}

export class GitLabRepo implements mGit.ManagedGitRepo<GitLabRepoIdentity> {
  readonly isGitRepo = true;
  readonly isGitHubRepo = true;
  readonly isRemoteGitRepo = true;
  readonly isManagedGitRepo = true;
  readonly tagsFetch: shc.SafeFetchJSON<gls.GitLabRepoTags>;

  constructor(readonly manager: GitLab, readonly identity: GitLabRepoIdentity) {
    this.tagsFetch = shc.safeFetchJSON;
  }

  apiClientContext(
    request: RequestInfo,
    options?: shc.TraverseOptions,
  ): GitLabRepoHttpClientContext {
    return {
      ...this.manager.apiClientContext(request, options),
      repo: this,
    };
  }

  url(): git.GitRepoRemoteURL {
    return `https://${this.manager.server.host}/${this.identity.group}/${this.identity.repo}`;
  }

  groupRepoApiURL(
    pathTemplate: string,
    params?: urlcat.ParamMap,
  ): string {
    return urlcat.default(
      `https://${this.manager.server.host}/api/v4`,
      pathTemplate,
      {
        ...params,
        // GitLab wants the group/sub-group/repo to be a single URL-encode string
        encodedGroupRepo: [this.identity.group, this.identity.repo].join("/"),
      },
    );
  }

  async repoTags(): Promise<git.GitTags | undefined> {
    const apiClientCtx = this.apiClientContext(
      this.groupRepoApiURL(
        "projects/:encodedGroupRepo/repository/tags",
      ),
    );
    const glTags = await this.tagsFetch(
      apiClientCtx,
      shc.jsonContentInspector(gls.isGitLabRepoTags),
    );
    if (glTags) {
      const result: git.GitTags = {
        gitRepoTags: [],
      };
      glTags.forEach((tag) => {
        result.gitRepoTags.push({ isGitTag: true, identity: tag.name });
      });
      return result;
    }
    return undefined;
  }

  async repoLatestTag(): Promise<git.GitTag | undefined> {
    const result = await this.repoTags();
    return result ? result.gitRepoTags[0] : undefined;
  }

  async content(
    ctx: mGit.ManagedGitContentContext,
  ): Promise<mGit.ManagedGitContent | undefined> {
    const apiClientCtx = this.apiClientContext(
      this.groupRepoApiURL(
        "projects/:encodedGroupRepo/repository/files/:filePath/raw",
        { filePath: ctx.path, ref: ctx.branchOrTag || "master" },
      ),
      shc.defaultTraverseOptions(),
    );
    const tr = await shc.traverse(
      apiClientCtx,
      shc.inspectHttpStatus,
      shc.inspectTextContent,
      shc.inspectHtmlContent,
      // shc.downloadInspector(),
      // shc.inspectFavIcon,
    );
    return shc.isTraversalContent(tr)
      ? mGit.prepareManagedGitContent(ctx, apiClientCtx, tr)
      : undefined;
  }
}
