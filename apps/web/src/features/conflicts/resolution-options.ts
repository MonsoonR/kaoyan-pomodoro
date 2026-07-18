import {
  ResolveConflictRequestSchema,
  type ConflictResolution,
  type ConflictType,
  type ResolveConflictRequest,
} from '@kaoyan/contracts';

export interface ResolutionOption {
  value: ConflictResolution;
  label: string;
  description: string;
  dangerous?: boolean;
}

const OPTIONS: Record<ConflictType, readonly ResolutionOption[]> = {
  delete_modify: [
    {
      value: 'keepServer',
      label: '保留另一台设备的内容',
      description: '取消本地删除，保留另一台设备上的最新内容。',
    },
    {
      value: 'applyDelete',
      label: '确认删除',
      description: '删除原任务及另一台设备上的修改。',
      dangerous: true,
    },
    {
      value: 'copyAsNew',
      label: '复制后删除原任务',
      description: '把另一台设备上的内容复制为新任务，再删除原任务。',
    },
  ],
  complete_restore: [
    {
      value: 'complete',
      label: '最终标记完成',
      description: '以已完成状态作为最终结果。',
    },
    {
      value: 'restore',
      label: '恢复为待完成',
      description: '把任务恢复到待完成状态。',
    },
  ],
  archive_add_today: [
    {
      value: 'keepArchived',
      label: '保持归档',
      description: '不把这个长期任务加入今日。',
    },
    {
      value: 'addAnyway',
      label: '归档但仍加入今日',
      description: '长期任务保持归档，同时创建今日任务。',
    },
    {
      value: 'unarchiveAndAdd',
      label: '取消归档并加入今日',
      description: '恢复长期任务，并创建今日任务。',
    },
  ],
};

export function resolutionOptionsFor(
  conflictType: ConflictType,
): readonly ResolutionOption[] {
  return OPTIONS[conflictType];
}

export function buildResolutionRequest(
  resolution: ConflictResolution,
  randomUUID: () => string,
): ResolveConflictRequest {
  const request = resolution === 'copyAsNew'
    ? { resolution, newEntityId: randomUUID() }
    : { resolution };
  return ResolveConflictRequestSchema.parse(request);
}
