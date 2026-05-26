export type ControlApiConnectionOptions = {
  url?: string;
  token?: string;
  configPath?: string;
};

export type ApiGetCommand = {
  kind: 'api-get';
  path: string;
  json: boolean;
};

export type ApiPostCommand = {
  kind: 'api-post';
  path: string;
  payload: Record<string, unknown>;
  json: boolean;
};

export type ApiDownloadCommand = {
  kind: 'api-download';
  path: string;
  outPath?: string;
  json: boolean;
};

export type ApiUploadCommand = {
  kind: 'api-upload';
  path: string;
  filePath: string;
  contentType: string;
  json: boolean;
};

export type PackageSearchCommand = {
  kind: 'package-search';
  query?: string;
  packageKind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle';
  json: boolean;
};

export type PackageInfoCommand = {
  kind: 'package-info';
  packageId: string;
  packageKind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle';
  json: boolean;
};

export type PackageInstallCommand = {
  kind: 'package-install';
  packageId: string;
  packageKind: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle';
  json: boolean;
};

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'init'; configPath?: string }
  | { kind: 'api-run-foreground'; configPath?: string }
  | { kind: 'api-start'; configPath?: string; url?: string; token?: string }
  | { kind: 'api-stop'; configPath?: string; url?: string; token?: string }
  | { kind: 'api-status'; configPath?: string; url?: string; token?: string }
  | { kind: 'worker-run'; configPath?: string }
  | ({ kind: 'interactive' } & ControlApiConnectionOptions)
  | ((PackageSearchCommand | PackageInfoCommand | PackageInstallCommand) & ControlApiConnectionOptions)
  | ((ApiGetCommand | ApiPostCommand | ApiDownloadCommand | ApiUploadCommand) & ControlApiConnectionOptions);
