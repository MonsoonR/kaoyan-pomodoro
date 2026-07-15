export const DATABASE_NAME = 'kaoyan-pomodoro-sync-v1';
export const DATABASE_VERSION = 2;

export const DATABASE_STORES = {
  replicas: '&key,userId,[userId+entityType+entityId]',
  operations:
    '++sequence,&[userId+operationId],operationId,userId,state,[userId+state+sequence],[userId+entityType+entityId]',
  metadata: '&userId,activeUserId',
  conflicts: '&key,id,userId,status,[userId+status]',
  timerCache: '&userId',
  syncIssues: '++id,&[userId+operationId],operationId,userId',
} as const;
