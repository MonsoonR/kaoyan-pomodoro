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
    phase: PhaseSchema,
    plannedSeconds: z.int().positive(),
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
export const CreateTaskRequestSchema = TaskFieldsSchema.extend({ id: IdSchema }).strict();
export const UpdateTaskRequestSchema = TaskPatchSchema.and(
  z.object({ expectedVersion: ExpectedVersionSchema }).strict(),
);
export const TaskIdParamsSchema = z.object({ taskId: IdSchema }).strict();
export const TaskListQuerySchema = z
  .object({ filter: z.enum(['active', 'archived', 'all']).default('active') })
  .strict();
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskSchema) }).strict();

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
export const CreateDailyTaskRequestSchema = DailyTaskFieldsSchema.omit({ sourceTaskId: true })
  .extend({ id: IdSchema })
  .strict();
export const UpdateDailyTaskRequestSchema = DailyTaskPatchSchema.and(
  z.object({ expectedVersion: ExpectedVersionSchema }).strict(),
);
export const DailyTaskIdParamsSchema = z.object({ dailyTaskId: IdSchema }).strict();
export const DailyTaskDateQuerySchema = z.object({ date: z.iso.date() }).strict();
export const DailyTaskListResponseSchema = z.object({ dailyTasks: z.array(DailyTaskSchema) }).strict();
export const AddToTodayRequestSchema = z
  .object({ id: IdSchema, date: z.iso.date(), sortOrder: z.int().nonnegative().default(0) })
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
    operationType: z.enum(['create', 'addToToday']),
    payload: DailyTaskFieldsSchema,
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
  phase: z.enum(['focus', 'short_break', 'long_break']),
  plannedSeconds: z.int().positive(),
  startedAt: TimestampSchema,
  targetEndAt: TimestampSchema,
  accumulatedPausedSeconds: z.int().nonnegative(),
});

export const ActiveTimerSchema = z.discriminatedUnion('status', [
  ActiveTimerBaseSchema.extend({
    status: z.literal('running'),
    pausedAt: z.null(),
  }),
  ActiveTimerBaseSchema.extend({
    status: z.literal('paused'),
    pausedAt: TimestampSchema,
  }),
]);

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const PushOperationsRequestSchema = z.object({
  operations: z.array(SyncOperationSchema).min(1).max(100),
});

const OperationReceiptBaseSchema = z.object({
  operationId: IdSchema,
});

export const OperationReceiptSchema = z.discriminatedUnion('status', [
  OperationReceiptBaseSchema.extend({
    status: z.literal('applied'),
    entityVersion: z.int().positive(),
    conflictId: z.null(),
  }),
  OperationReceiptBaseSchema.extend({
    status: z.literal('duplicate'),
    entityVersion: z.int().positive(),
    conflictId: z.null(),
  }),
  OperationReceiptBaseSchema.extend({
    status: z.literal('conflict'),
    entityVersion: z.int().positive().nullable(),
    conflictId: IdSchema,
  }),
]);

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
});

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
export type CreateDailyTaskRequest = z.infer<typeof CreateDailyTaskRequestSchema>;
export type UpdateDailyTaskRequest = z.infer<typeof UpdateDailyTaskRequestSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
