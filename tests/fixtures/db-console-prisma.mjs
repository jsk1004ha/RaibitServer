export const queryState = { rows: [], statements: [], disconnects: 0 };

export class PrismaClient {
  async $transaction(callback) {
    return callback(this);
  }

  async $executeRawUnsafe(sql) {
    queryState.statements.push(sql);
    return 0;
  }

  async $queryRawUnsafe(sql) {
    queryState.statements.push(sql);
    return structuredClone(queryState.rows);
  }

  async $disconnect() {
    queryState.disconnects += 1;
  }
}
