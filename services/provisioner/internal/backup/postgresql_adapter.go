package backup

const postgresqlCustomFormat = "postgresql-custom"

type PostgreSQLAdapter struct{ sqlAdapter }

func NewPostgreSQLAdapter() PostgreSQLAdapter {
	return PostgreSQLAdapter{sqlAdapter{engine: EnginePostgreSQL, formatName: postgresqlCustomFormat, dumpPlan: postgresqlDumpPlan, restorePlan: postgresqlRestorePlan}}
}

func postgresqlDumpPlan(connection Connection) ([]sqlCommandPlan, error) {
	if _, err := sqlEndpoint(connection); err != nil {
		return nil, err
	}
	return []sqlCommandPlan{
		{executable: sqlRecoveryHelper, args: []string{"postgresql-verify"}, binding: StreamNone},
		{executable: sqlRecoveryHelper, args: []string{"postgresql-dump"}, binding: StreamStdout},
	}, nil
}

func postgresqlRestorePlan(connection Connection) ([]sqlCommandPlan, error) {
	if _, err := sqlEndpoint(connection); err != nil {
		return nil, err
	}
	return []sqlCommandPlan{
		{executable: sqlRecoveryHelper, args: []string{"postgresql-restore"}, binding: StreamStdin},
		{executable: sqlRecoveryHelper, args: []string{"postgresql-verify"}, binding: StreamNone},
	}, nil
}

var _ RecoveryAdapter = PostgreSQLAdapter{}
