package backup

const (
	postgresqlCustomFormat = "postgresql-custom"
	postgresqlVerifySQL    = `SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema'); SELECT 1 FROM public.raibitserver_restore_sentinel LIMIT 1;`
)

type PostgreSQLAdapter struct{ sqlAdapter }

func NewPostgreSQLAdapter() PostgreSQLAdapter {
	return PostgreSQLAdapter{sqlAdapter{engine: EnginePostgreSQL, formatName: postgresqlCustomFormat, passwordEnv: "PGPASSWORD", dumpPlan: postgresqlDumpPlan, restorePlan: postgresqlRestorePlan}}
}

func postgresqlDumpPlan(connection Connection) ([]sqlCommandPlan, error) {
	endpoint, err := sqlEndpoint(connection)
	if err != nil {
		return nil, err
	}
	return []sqlCommandPlan{
		{executable: "psql", args: postgresqlVerificationArgs(endpoint), binding: StreamNone},
		{executable: "pg_dump", args: []string{"--format=custom", "--no-owner", "--no-privileges", "--port", sqlPort(endpoint.Port), "--username", endpoint.User, "--dbname", endpoint.Database}, binding: StreamStdout},
	}, nil
}

func postgresqlRestorePlan(connection Connection) ([]sqlCommandPlan, error) {
	endpoint, err := sqlEndpoint(connection)
	if err != nil {
		return nil, err
	}
	return []sqlCommandPlan{
		{executable: "pg_restore", args: []string{"--exit-on-error", "--no-owner", "--no-privileges", "--port", sqlPort(endpoint.Port), "--username", endpoint.User, "--dbname", endpoint.Database}, binding: StreamStdin},
		{executable: "psql", args: postgresqlVerificationArgs(endpoint), binding: StreamNone},
	}, nil
}

func postgresqlVerificationArgs(endpoint NetworkEndpointSpec) []string {
	return []string{"--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--port", sqlPort(endpoint.Port), "--username", endpoint.User, "--dbname", endpoint.Database, "--command", postgresqlVerifySQL}
}

var _ RecoveryAdapter = PostgreSQLAdapter{}
