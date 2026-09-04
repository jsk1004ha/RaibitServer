package backup

const (
	mysqlLogicalFormat   = "mysql-logical"
	mariaDBLogicalFormat = "mariadb-logical"
)

type MySQLAdapter struct{ sqlAdapter }

func NewMySQLRecoveryAdapter() MySQLAdapter {
	return MySQLAdapter{sqlAdapter{engine: EngineMySQL, formatName: mysqlLogicalFormat, dumpPlan: mysqlDumpPlan, restorePlan: mysqlRestorePlan}}
}

func NewMariaDBRecoveryAdapter() MySQLAdapter {
	return MySQLAdapter{sqlAdapter{engine: EngineMariaDB, formatName: mariaDBLogicalFormat, dumpPlan: mysqlDumpPlan, restorePlan: mysqlRestorePlan}}
}

func mysqlDumpPlan(connection Connection) ([]sqlCommandPlan, error) {
	if _, err := sqlEndpoint(connection); err != nil {
		return nil, err
	}
	engine := connection.Engine()
	return []sqlCommandPlan{
		{executable: sqlRecoveryHelper, args: []string{string(engine) + "-verify"}, binding: StreamNone},
		{executable: sqlRecoveryHelper, args: []string{string(engine) + "-dump"}, binding: StreamStdout},
	}, nil
}

func mysqlRestorePlan(connection Connection) ([]sqlCommandPlan, error) {
	if _, err := sqlEndpoint(connection); err != nil {
		return nil, err
	}
	engine := connection.Engine()
	return []sqlCommandPlan{
		{executable: sqlRecoveryHelper, args: []string{string(engine) + "-restore"}, binding: StreamStdin},
		{executable: sqlRecoveryHelper, args: []string{string(engine) + "-verify"}, binding: StreamNone},
	}, nil
}

var _ RecoveryAdapter = MySQLAdapter{}
