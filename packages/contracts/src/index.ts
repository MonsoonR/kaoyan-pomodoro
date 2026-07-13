import { z } from 'zod';

const IdSchema = z.uuid();
const TimestampSchema = z.iso.datetime({ offset: true });
const PayloadSchema = z.record(z.string(), z.unknown());
const EmptyPayloadSchema = z.object({}).strict();
const TimerPresetSchema = z.enum(['25-5', '50-10', 'custom']);
const PhaseSchema = z.enum(['focus', 'short_break', 'long_break']);
const ExpectedVersionSchema = z.int().positive();

export const UsernameSchema = z.string().trim().min(3).max(64);
export const PasswordSchema = z.string().min(12).max(128);
export const LoginRequestSchema = z
  .object({
    username: UsernameSchema,
    password: PasswordSchema,
  })
  .strict();
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: PasswordSchema,
    newPassword: PasswordSchema,
    confirmPassword: PasswordSchema,
  })
  .strict()
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export const AuthUserSchema = z
  .object({ id: IdSchema, username: UsernameSchema })
  .strict();
export const CurrentSessionSchema = z
  .object({
    user: AuthUserSchema,
    deviceId: IdSchema,
    deviceName: z.string().min(1).max(100),
    expiresAt: TimestampSchema,
  })
  .strict();
export const DeviceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(100),
    browser: z.string().min(1).max(50),
    operatingSystem: z.string().min(1).max(50),
    isCurrent: z.boolean(),
    firstLoginAt: TimestampSchema,
    lastActiveAt: TimestampSchema,
  })
  .strict();
export const RenameDeviceRequestSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
export const LoginResponseSchema = CurrentSessionSchema;
export const DeviceIdParamsSchema = z.object({ deviceId: IdSchema }).strict();
export const DeviceListResponseSchema = z
  .object({ devices: z.array(DeviceSchema) })
  .strict();
export const SuccessResponseSchema = z.object({ ok: z.literal(true) }).strict();

const TaskFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(50),
    defaultPomodoroTarget: z.int().min(1).max(99),
    defaultTimerPreset: TimerPresetSchema,
    notes: z.string().max(5_000).nullable().optional(),
  })
  .strict();

const TaskPatchSchema = TaskFieldsSchema.partial().refine(
  (payload) => Object.keys(payload).length > 0,
  { message: 'Task update payload cannot be empty' },
);

const DailyTaskFieldsSchema = z
  .object({
    sourceTaskId: IdSchema.nullable(),
    date: z.iso.date(),
    title: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(50),
    pomodoroTarget: z.int().min(1).max(99),
    timerPreset: TimerPresetSchema,
    sortOrder: z.int().nonnegative(),
  })
  .strict();

const DailyTaskPatchSchema = DailyTaskFieldsSchema.omit({
  sourceTaskId: true,
  date: true,
})
  .partial()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'Daily task update payload cannot be empty',
  });

const FocusSessionCreatePayloadSchema = z
  .object({
    dailyTaskId: IdSchema,
    taskTitle: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(50),
    phase: PhaseSchema,
    plannedSeconds: z.int().positive(),
    effectiveSeconds: z.int().nonnegative(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    result: z.enum(['completed', 'interrupted', 'abandoned']),
    interruptionReason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

const TimerStartPayloadSchema = z
  .object({
    dailyTaskId: IdSchema,
    dailyTaskVersion: ExpectedVersionSchema,
    phase: PhaseSchema,
    plannedSeconds: z.int().min(1).max(10_800),
  })
  .strict();

const ReasonPayloadSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const SettingsPatchSchema = z
  .object({
    defaultPreset: TimerPresetSchema.optional(),
    customFocusMinutes: z.int().min(1).max(180).optional(),
    customShortBreakMinutes: z.int().min(1).max(60).optional(),
    customLongBreakMinutes: z.int().min(1).max(120).optional(),
    longBreakInterval: z.int().min(1).max(12).optional(),
    soundEnabled: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'Settings update payload cannot be empty',
  });

export const VersionedMutationRequestSchema = z
  .object({ expectedVersion: ExpectedVersionSchema })
  .strict();

export const TaskSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(200),
    subject: z.string().min(1).max(50),
    defaultPomodoroTarget: z.int().min(1).max(99),
    defaultTimerPreset: TimerPresetSchema,
    notes: z.string().max(5_000).nullable(),
    archived: z.boolean(),
    version: z.int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: TimestampSchema.nullable(),
  })
  .strict();
export const CreateTaskRequestSchema = TaskFieldsSchema.extend({
  id: IdSchema,
}).strict();
export const UpdateTaskRequestSchema = TaskPatchSchema.and(
  z.object({ expectedVersion: ExpectedVersionSchema }).strict(),
);
export const TaskIdParamsSchema = z.object({ taskId: IdSchema }).strict();
export const TaskListQuerySchema = z
  .object({ filter: z.enum(['active', 'archived', 'all']).default('active') })
  .strict();
export const TaskListResponseSchema = z
  .object({ tasks: z.array(TaskSchema) })
  .strict();

export const DailyTaskSchema = z
  .object({
    id: IdSchema,
    sourceTaskId: IdSchema.nullable(),
    date: z.iso.date(),
    title: z.string().min(1).max(200),
    subject: z.string().min(1).max(50),
    pomodoroTarget: z.int().min(1).max(99),
    pomodoroCompleted: z.int().nonnegative(),
    timerPreset: TimerPresetSchema,
    status: z.enum(['pending', 'active', 'awaiting_confirmation', 'completed']),
    sortOrder: z.int().nonnegative(),
    completedAt: TimestampSchema.nullable(),
    version: z.int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: TimestampSchema.nullable(),
  })
  .strict();
export const CreateDailyTaskRequestSchema = DailyTaskFieldsSchema.omit({
  sourceTaskId: true,
})
  .extend({ id: IdSchema })
  .strict();
export const UpdateDailyTaskRequestSchema = DailyTaskPatchSchema.and(
  z.object({ expectedVersion: ExpectedVersionSchema }).strict(),
);
export const DailyTaskIdParamsSchema = z
  .object({ dailyTaskId: IdSchema })
  .strict();
export const DailyTaskDateQuerySchema = z
  .object({ date: z.iso.date() })
  .strict();
export const DailyTaskListResponseSchema = z
  .object({ dailyTasks: z.array(DailyTaskSchema) })
  .strict();
export const AddToTodayRequestSchema = z
  .object({
    id: IdSchema,
    date: z.iso.date(),
    sortOrder: z.int().nonnegative().default(0),
  })
  .strict();
export const CompleteDailyTaskRequestSchema = VersionedMutationRequestSchema;
export const RestoreDailyTaskRequestSchema = VersionedMutationRequestSchema;

export const SettingsSchema = z
  .object({
    id: IdSchema,
    defaultPreset: TimerPresetSchema,
    customFocusMinutes: z.int().min(1).max(180),
    customShortBreakMinutes: z.int().min(1).max(60),
    customLongBreakMinutes: z.int().min(1).max(120),
    longBreakInterval: z.int().min(1).max(12),
    soundEnabled: z.boolean(),
    notificationsEnabled: z.boolean(),
    version: z.int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: z.null(),
  })
  .strict();
export const UpdateSettingsRequestSchema = SettingsPatchSchema.and(
  z.object({ expectedVersion: ExpectedVersionSchema }).strict(),
);
export const StaleVersionErrorSchema = z
  .object({
    code: z.literal('STALE_VERSION'),
    message: z.literal('Entity version is stale'),
    currentVersion: z.int().positive(),
  })
  .strict();

export const EntityVersionSchema = z.object({
  id: IdSchema,
  version: z.int().positive(),
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.nullable(),
});

export const SyncEntityTypeSchema = z.enum([
  'task',
  'dailyTask',
  'focusSession',
  'activeTimer',
  'settings',
]);

export const SyncOperationTypeSchema = z.enum([
  'create',
  'update',
  'delete',
  'complete',
  'restore',
  'archive',
  'unarchive',
  'addToToday',
  'timerStart',
  'timerPause',
  'timerResume',
  'timerComplete',
  'timerExit',
]);

const SyncOperationBaseSchema = z
  .object({
    operationId: IdSchema,
    entityId: IdSchema,
    baseVersion: z.int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();

export const SyncOperationSchema = z.union([
  SyncOperationBaseSchema.extend({
    entityType: z.literal('task'),
    operationType: z.literal('create'),
    payload: TaskFieldsSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('task'),
    operationType: z.literal('update'),
    payload: TaskPatchSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('task'),
    operationType: z.enum(['delete', 'archive', 'unarchive']),
    payload: EmptyPayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('dailyTask'),
    operationType: z.literal('create'),
    payload: DailyTaskFieldsSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('dailyTask'),
    operationType: z.literal('addToToday'),
    payload: z
      .object({
        sourceTaskId: IdSchema,
        sourceTaskVersion: z.int().positive(),
        date: z.iso.date(),
        sortOrder: z.int().nonnegative(),
      })
      .strict(),
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('dailyTask'),
    operationType: z.literal('update'),
    payload: DailyTaskPatchSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('dailyTask'),
    operationType: z.enum(['delete', 'complete', 'restore']),
    payload: EmptyPayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('focusSession'),
    operationType: z.literal('create'),
    payload: FocusSessionCreatePayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('activeTimer'),
    operationType: z.literal('timerStart'),
    payload: TimerStartPayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('activeTimer'),
    operationType: z.literal('timerPause'),
    payload: ReasonPayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('activeTimer'),
    operationType: z.enum(['timerResume', 'timerComplete']),
    payload: EmptyPayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('activeTimer'),
    operationType: z.literal('timerExit'),
    payload: ReasonPayloadSchema,
  }),
  SyncOperationBaseSchema.extend({
    entityType: z.literal('settings'),
    operationType: z.literal('update'),
    payload: SettingsPatchSchema,
  }),
]);

const SyncChangeBaseSchema = z.object({
  cursor: z.int().positive(),
  entityType: SyncEntityTypeSchema,
  entityId: IdSchema,
  version: z.int().positive(),
  changedAt: TimestampSchema,
});

export const SyncChangeSchema = z.discriminatedUnion('changeType', [
  SyncChangeBaseSchema.extend({
    changeType: z.literal('upsert'),
    payload: PayloadSchema,
  }),
  SyncChangeBaseSchema.extend({
    changeType: z.literal('delete'),
    payload: z.null(),
  }),
]);

const ActiveTimerBaseSchema = EntityVersionSchema.extend({
  dailyTaskId: IdSchema,
  taskTitle: z.string().min(1).max(200),
  subject: z.string().min(1).max(50),
  phase: PhaseSchema,
  plannedSeconds: z.int().min(1).max(10_800),
  startedAt: TimestampSchema,
  targetEndAt: TimestampSchema,
  accumulatedPausedSeconds: z.int().nonnegative(),
  interruptionReason: z.string().min(1).max(500).nullable(),
});

export const ActiveTimerSchema = z.discriminatedUnion('status', [
  ActiveTimerBaseSchema.extend({
    status: z.literal('running'),
    pausedAt: z.null(),
  }).strict(),
  ActiveTimerBaseSchema.extend({
    status: z.literal('paused'),
    pausedAt: TimestampSchema,
  }).strict(),
]);

export const FocusSessionSchema = z
  .object({
    id: IdSchema,
    dailyTaskId: IdSchema.nullable(),
    taskTitle: z.string().min(1).max(200),
    subject: z.string().min(1).max(50),
    phase: PhaseSchema,
    plannedSeconds: z.int().min(1).max(10_800),
    effectiveSeconds: z.int().nonnegative().max(10_800),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    result: z.enum(['completed', 'interrupted', 'abandoned']),
    interruptionReason: z.string().min(1).max(500).nullable(),
    version: z.literal(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: z.null(),
  })
  .strict();

export const TimerIdParamsSchema = z.object({ timerId: IdSchema }).strict();
export const StartTimerRequestSchema = z
  .object({
    id: IdSchema,
    dailyTaskId: IdSchema,
    dailyTaskVersion: ExpectedVersionSchema,
    phase: PhaseSchema,
    plannedSeconds: z.int().min(1).max(10_800),
  })
  .strict();
export const PauseTimerRequestSchema = z
  .object({
    expectedVersion: ExpectedVersionSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const ResumeTimerRequestSchema = VersionedMutationRequestSchema;
export const CompleteTimerRequestSchema = VersionedMutationRequestSchema;
export const ExitTimerRequestSchema = PauseTimerRequestSchema;

export const StartTimerResponseSchema = z
  .object({
    outcome: z.enum(['started', 'existing']),
    timer: ActiveTimerSchema,
    serverTime: TimestampSchema,
  })
  .strict();
export const TimerFinalizationResponseSchema = z
  .object({
    outcome: z.enum(['finalized', 'alreadyFinalized']),
    focusSession: FocusSessionSchema,
    serverTime: TimestampSchema,
  })
  .strict();
export const StaleTimerVersionErrorSchema = z
  .object({
    code: z.literal('STALE_TIMER_VERSION'),
    message: z.literal('Timer version is stale'),
    currentVersion: z.int().positive(),
    currentTimer: ActiveTimerSchema,
    serverTime: TimestampSchema,
  })
  .strict();

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const PushOperationsRequestSchema = z
  .object({ operations: z.array(z.unknown()).min(1).max(100) })
  .strict();

const OperationReceiptBaseSchema = z.object({
  operationId: IdSchema,
});

const ValidOperationReceiptSchema = z.discriminatedUnion('status', [
  OperationReceiptBaseSchema.extend({
    status: z.literal('applied'),
    entityVersion: z.int().positive(),
    conflictId: z.null(),
    errorCode: z.null(),
    errorMessage: z.null(),
  }).strict(),
  OperationReceiptBaseSchema.extend({
    status: z.literal('duplicate'),
    entityVersion: z.int().positive(),
    conflictId: z.null(),
    errorCode: z.null(),
    errorMessage: z.null(),
  }).strict(),
  OperationReceiptBaseSchema.extend({
    status: z.literal('conflict'),
    entityVersion: z.int().positive().nullable(),
    conflictId: IdSchema,
    errorCode: z.null(),
    errorMessage: z.null(),
  }).strict(),
  OperationReceiptBaseSchema.extend({
    status: z.literal('rejected'),
    entityVersion: z.int().positive().nullable(),
    conflictId: z.null(),
    errorCode: z.string().min(1),
    errorMessage: z.string().min(1),
  }).strict(),
]);
export const OperationReceiptSchema = z.union([
  ValidOperationReceiptSchema,
  z
    .object({
      operationId: z.null(),
      index: z.int().nonnegative(),
      status: z.literal('rejected'),
      entityVersion: z.null(),
      conflictId: z.null(),
      errorCode: z.literal('MALFORMED_OPERATION'),
      errorMessage: z.literal('Operation is malformed'),
    })
    .strict(),
]);

export const ConflictTypeSchema = z.enum([
  'delete_modify',
  'complete_restore',
  'archive_add_today',
]);
export const ConflictResolutionSchema = z.enum([
  'keepServer',
  'applyDelete',
  'copyAsNew',
  'complete',
  'restore',
  'keepArchived',
  'addAnyway',
  'unarchiveAndAdd',
]);
export const ResolveConflictRequestSchema = z.discriminatedUnion('resolution', [
  z
    .object({
      resolution: z.enum([
        'keepServer',
        'applyDelete',
        'complete',
        'restore',
        'keepArchived',
        'addAnyway',
      ]),
    })
    .strict(),
  z
    .object({ resolution: z.literal('copyAsNew'), newEntityId: IdSchema })
    .strict(),
  z.object({ resolution: z.literal('unarchiveAndAdd') }).strict(),
]);
export const CurrentResolvedConflictResultSchema = z
  .object({
    resolutionRequest: ResolveConflictRequestSchema,
    affectedVersions: z.record(IdSchema, z.int().positive()),
  })
  .strict();
export const LegacyResolvedConflictResultSchema = z
  .object({
    legacy: z.literal(true),
    resolution: ConflictResolutionSchema,
    affectedVersions: z.record(IdSchema, z.int().positive()),
  })
  .strict();
export const ResolvedConflictResultSchema = z.union([
  CurrentResolvedConflictResultSchema,
  LegacyResolvedConflictResultSchema,
]);
export const InvalidConflictResolutionErrorSchema = z
  .object({
    code: z.literal('INVALID_CONFLICT_RESOLUTION'),
    message: z.literal('Resolution is not valid for this conflict type'),
    conflictType: ConflictTypeSchema,
    resolution: ConflictResolutionSchema,
  })
  .strict();
export const ConflictAlreadyResolvedErrorSchema = z
  .object({
    code: z.literal('CONFLICT_ALREADY_RESOLVED'),
    message: z.literal('Conflict was already resolved differently'),
    resolution: ConflictResolutionSchema,
    resolutionResult: ResolvedConflictResultSchema,
  })
  .strict();
export const ConflictResolutionTargetExistsErrorSchema = z
  .object({
    code: z.literal('CONFLICT_RESOLUTION_TARGET_EXISTS'),
    message: z.literal('Conflict resolution target already exists'),
    entityId: IdSchema,
  })
  .strict();

const ConflictBaseSchema = z
  .object({
    id: IdSchema,
    entityType: SyncEntityTypeSchema,
    entityId: IdSchema,
    conflictType: ConflictTypeSchema,
    localOperationId: IdSchema,
    baseVersion: z.int().nonnegative(),
    serverVersion: z.int().positive(),
    localPayload: PayloadSchema,
    serverPayload: PayloadSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export const ConflictSchema = z.discriminatedUnion('status', [
  ConflictBaseSchema.extend({
    status: z.literal('open'),
    resolution: z.null(),
    resolutionResult: z.null(),
    resolvedAt: z.null(),
  }).strict(),
  ConflictBaseSchema.extend({
    status: z.literal('resolved'),
    resolution: ConflictResolutionSchema,
    resolutionResult: ResolvedConflictResultSchema,
    resolvedAt: TimestampSchema,
  }).strict(),
]);
export const ConflictListResponseSchema = z
  .object({ conflicts: z.array(ConflictSchema) })
  .strict();
export const ConflictIdParamsSchema = z
  .object({ conflictId: IdSchema })
  .strict();
export const ResolveConflictResponseSchema = z
  .object({
    conflict: ConflictSchema,
    affectedVersions: z.record(IdSchema, z.int().positive()),
  })
  .strict();

export const PushOperationsResponseSchema = z.object({
  receipts: z.array(OperationReceiptSchema),
  latestCursor: z.int().nonnegative(),
});

export const PullChangesQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const PullChangesResponseSchema = z.object({
  changes: z.array(SyncChangeSchema),
  nextCursor: z.int().nonnegative(),
  hasMore: z.boolean(),
});

export const TimerStateResponseSchema = z.object({
  timer: ActiveTimerSchema.nullable(),
  serverTime: TimestampSchema,
}).strict();

export type EntityVersion = z.infer<typeof EntityVersionSchema>;
export type CurrentSession = z.infer<typeof CurrentSessionSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceIdParams = z.infer<typeof DeviceIdParamsSchema>;
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;
export type SyncOperationType = z.infer<typeof SyncOperationTypeSchema>;
export type SyncOperation = z.infer<typeof SyncOperationSchema>;
export type SyncChange = z.infer<typeof SyncChangeSchema>;
export type ActiveTimer = z.infer<typeof ActiveTimerSchema>;
export type FocusSession = z.infer<typeof FocusSessionSchema>;
export type StartTimerRequest = z.infer<typeof StartTimerRequestSchema>;
export type PauseTimerRequest = z.infer<typeof PauseTimerRequestSchema>;
export type ResumeTimerRequest = z.infer<typeof ResumeTimerRequestSchema>;
export type CompleteTimerRequest = z.infer<typeof CompleteTimerRequestSchema>;
export type ExitTimerRequest = z.infer<typeof ExitTimerRequestSchema>;
export type StartTimerResponse = z.infer<typeof StartTimerResponseSchema>;
export type TimerFinalizationResponse = z.infer<
  typeof TimerFinalizationResponseSchema
>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type PushOperationsRequest = z.infer<typeof PushOperationsRequestSchema>;
export type PushOperationsResponse = z.infer<
  typeof PushOperationsResponseSchema
>;
export type PullChangesQuery = z.infer<typeof PullChangesQuerySchema>;
export type PullChangesResponse = z.infer<typeof PullChangesResponseSchema>;
export type TimerStateResponse = z.infer<typeof TimerStateResponseSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type DailyTask = z.infer<typeof DailyTaskSchema>;
export type CreateDailyTaskRequest = z.infer<
  typeof CreateDailyTaskRequestSchema
>;
export type UpdateDailyTaskRequest = z.infer<
  typeof UpdateDailyTaskRequestSchema
>;
export type Settings = z.infer<typeof SettingsSchema>;
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;
export type Conflict = z.infer<typeof ConflictSchema>;
export type ConflictType = z.infer<typeof ConflictTypeSchema>;
export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;
export type ResolveConflictRequest = z.infer<
  typeof ResolveConflictRequestSchema
>;
export type ResolvedConflictResult = z.infer<
  typeof ResolvedConflictResultSchema
>;
export type CurrentResolvedConflictResult = z.infer<
  typeof CurrentResolvedConflictResultSchema
>;
