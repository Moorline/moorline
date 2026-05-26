interface ManagementContribution {
  placement?: string;
}

interface ManagementReadModel {
  overview: {
    sessions: number;
    missions: number;
    pendingRequests: number;
  };
  runtime: {
    status: {
      runningSessions: number;
      waitingSessions: number;
    };
    control: {
      acceptingNewWork: boolean;
    };
  } & Record<string, unknown>;
  diagnostics: {
    runtimeHealth: unknown;
    recentRuntimeActivities: unknown;
    recentAuditEvents: unknown;
  };
  objects: {
    managementContributions: ManagementContribution[];
    sessions: unknown;
    missions: unknown;
    pendingRequests: unknown;
  };
  setup: unknown;
  settings: unknown;
  packages: {
    catalog?: unknown;
    installed?: unknown;
  } & Record<string, unknown>;
  history: {
    status?: unknown;
    entries?: unknown;
  } & Record<string, unknown>;
}

export interface ControlApiState {
  generatedAt: string;
  runtimeMode: 'runtime' | 'management_only';
  readModel: ManagementReadModel;
  operations: ControlApiOperationsState;
  configure: ControlApiConfigureState;
}

export interface ControlApiOperationsState {
  summary: {
    sessions: number;
    missions: number;
    pendingRequests: number;
    runningSessions: number;
    waitingSessions: number;
    acceptingNewWork: boolean;
  };
  runtime: ManagementReadModel['runtime'];
  diagnostics: Pick<ManagementReadModel['diagnostics'], 'runtimeHealth' | 'recentRuntimeActivities' | 'recentAuditEvents'>;
  managementContributions: ManagementReadModel['objects']['managementContributions'];
  sessions: ManagementReadModel['objects']['sessions'];
  missions: ManagementReadModel['objects']['missions'];
  pendingRequests: ManagementReadModel['objects']['pendingRequests'];
}

export interface ControlApiConfigureState {
  setup: ManagementReadModel['setup'];
  settings: ManagementReadModel['settings'];
  packages: ManagementReadModel['packages'];
  history: ManagementReadModel['history'];
  managementContributions: ManagementReadModel['objects']['managementContributions'];
}

export function projectOperationsState(model: ManagementReadModel): ControlApiOperationsState {
  return {
    summary: {
      sessions: model.overview.sessions,
      missions: model.overview.missions,
      pendingRequests: model.overview.pendingRequests,
      runningSessions: model.runtime.status.runningSessions,
      waitingSessions: model.runtime.status.waitingSessions,
      acceptingNewWork: model.runtime.control.acceptingNewWork
    },
    runtime: model.runtime,
    diagnostics: {
      runtimeHealth: model.diagnostics.runtimeHealth,
      recentRuntimeActivities: model.diagnostics.recentRuntimeActivities,
      recentAuditEvents: model.diagnostics.recentAuditEvents
    },
    managementContributions: model.objects.managementContributions.filter((contribution: { placement?: string }) =>
      typeof contribution.placement === 'string' && ['overview', 'control', 'work', 'health'].includes(contribution.placement)
    ),
    sessions: model.objects.sessions,
    missions: model.objects.missions,
    pendingRequests: model.objects.pendingRequests
  };
}

export function projectConfigureState(model: ManagementReadModel): ControlApiConfigureState {
  return {
    setup: model.setup,
    settings: model.settings,
    packages: model.packages,
    history: model.history,
    managementContributions: model.objects.managementContributions.filter((contribution: { placement?: string }) =>
      typeof contribution.placement === 'string' && ['packages', 'settings'].includes(contribution.placement)
    )
  };
}
