export const DATABASE_NAME = 'kaoyan-pomodoro-sync-v1';
export const DATABASE_VERSION = 1;

export const DATABASE_STORES = {
  replicas: '&key,userId,[userId+entityType+entityId]',
  operations:
    '++sequence,&operationId,userId,state,[userId+state+sequence],[userId+entityType+entityId]',
  metadata: '&userId,activeUserId',
  conflicts: '&key,id,userId,status,[userId+status]',
  timerCache: '&userId',
  syncIssues: '++id,&operationId,userId',
} as const;
