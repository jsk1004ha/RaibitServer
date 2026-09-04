package backup

const (
	mysqlLogicalFormat   = "mysql-logical"
	mariaDBLogicalFormat = "mariadb-logical"
	mysqlVerifySQL       = `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE(); SELECT 1 FROM raibitserver_restore_sentinel LIMIT 1;`
)

type MySQLAdapter struct{ sqlAdapter }

func NewMySQLRecoveryAdapter() MySQLAdapter {
	return MySQLAdapter{sqlAdapter{engine: EngineMySQL, formatName: mysqlLogicalFormat, passwordEnv: "MYSQL_PWD", dumpPlan: mysqlDumpPlan, restorePlan: mysqlRestorePlan}}
}

func NewMariaDBRecoveryAdapter() MySQLAdapter {
	return MySQLAdapter{sqlAdapter{engine: EngineMariaDB, formatName: mariaDBLogicalFormat, passwordEnv: "MYSQL_PWD", dumpPlan: mysqlDumpPlan, restorePlan: mysqlRestorePlan}}
}

func mysqlDumpPlan(connection Connection) ([]sqlCommandPlan, error) {
	endpoint, err := sqlEndpoint(connection)
	if err != nil {
		return nil, err
	}
	connectionArgs := mysqlConnectionArgs(endpoint)
	dumpArgs := []string{"--single-transaction", "--routines", "--events", "--triggers", "--hex-blob"}
	dumpArgs = append(dumpArgs, connectionArgs...)
	dumpArgs = append(dumpArgs, "--databases", endpoint.Database)
	return []sqlCommandPlan{
		{executable: "mysql", args: mysqlVerificationArgs(endpoint), binding: StreamNone},
		{executable: "mysqldump", args: dumpArgs, binding: StreamStdout},
	}, nil
}

func mysqlRestorePlan(connection Connection) ([]sqlCommandPlan, error) {
	endpoint, err := sqlEndpoint(connection)
	if err != nil {
		return nil, err
	}
	restoreArgs := []string{"--binary-mode"}
	restoreArgs = append(restoreArgs, mysqlConnectionArgs(endpoint)...)
	restoreArgs = append(restoreArgs, "--database", endpoint.Database)
	return []sqlCommandPlan{
		{executable: "mysql", args: restoreArgs, binding: StreamStdin},
		{executable: "mysql", args: mysqlVerificationArgs(endpoint), binding: StreamNone},
	}, nil
}

func mysqlConnectionArgs(endpoint NetworkEndpointSpec) []string {
	return []string{"--protocol=TCP", "--port", sqlPort(endpoint.Port), "--user", endpoint.User}
}

func mysqlVerificationArgs(endpoint NetworkEndpointSpec) []string {
	args := []string{"--batch", "--skip-column-names", "--raw"}
	args = append(args, mysqlConnectionArgs(endpoint)...)
	return append(args, "--database", endpoint.Database, "--execute", mysqlVerifySQL)
}

var _ RecoveryAdapter = MySQLAdapter{}
