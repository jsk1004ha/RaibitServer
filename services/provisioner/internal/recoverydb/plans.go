package recoverydb

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
)

const (
	postgresVerifySQL = `CREATE TEMPORARY TABLE raibitserver_recovery_verify (marker text PRIMARY KEY); INSERT INTO raibitserver_recovery_verify VALUES ('raibitserver-recovery-v1'); SELECT marker FROM raibitserver_recovery_verify WHERE marker='raibitserver-recovery-v1'; DROP TABLE raibitserver_recovery_verify;`
	mysqlVerifySQL    = `CREATE TEMPORARY TABLE raibitserver_recovery_verify (marker VARCHAR(64) PRIMARY KEY); INSERT INTO raibitserver_recovery_verify VALUES ('raibitserver-recovery-v1'); SELECT marker FROM raibitserver_recovery_verify WHERE marker='raibitserver-recovery-v1'; DROP TEMPORARY TABLE raibitserver_recovery_verify;`
	mongoVerifyScript = `const fs = require("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.RAIBIT_MONGODB_CONFIG, "utf8")); const uri = new URL(cfg.uri); uri.password = cfg.password; const target = connect(uri.toString()); const sentinel = target.getCollection("raibitserver_recovery_verify"); let verified = false; try { sentinel.insertOne({_id: "raibitserver-recovery-v1"}); verified = sentinel.findOne({_id: "raibitserver-recovery-v1"}) !== null; } finally { sentinel.drop(); } if (!verified) { quit(3); } print("raibitserver-recovery-v1");`
)

func buildPlan(selected action, target endpoint, work workspace) (processSpec, error) {
	switch selected.engine {
	case enginePostgreSQL:
		return postgresqlPlan(selected.operation, target, work)
	case engineMySQL:
		return mysqlPlan(selected.operation, target, work, false)
	case engineMariaDB:
		return mysqlPlan(selected.operation, target, work, true)
	case engineMongoDB:
		return mongodbPlan(selected.operation, target, work)
	default:
		return processSpec{}, ErrInvalidInput
	}
}

func postgresqlPlan(selected operation, target endpoint, work workspace) (processSpec, error) {
	service := fmt.Sprintf("[raibit-recovery]\nhost=%s\nport=%s\ndbname=%s\nuser=%s\n", target.host, target.port, target.database, target.username)
	servicePath, err := work.write("pg_service.conf", []byte(service))
	if err != nil {
		return processSpec{}, err
	}
	passfile := fmt.Sprintf("%s:%s:%s:%s:%s\n", escapePGPass(target.host), target.port, escapePGPass(target.database), escapePGPass(target.username), escapePGPass(target.password))
	passPath, err := work.write("pgpass", []byte(passfile))
	if err != nil {
		return processSpec{}, err
	}
	spec := processSpec{env: []string{"LC_ALL=C", "PGSERVICE=raibit-recovery", "PGSERVICEFILE=" + servicePath, "PGPASSFILE=" + passPath}, configPaths: []string{servicePath, passPath}}
	switch selected {
	case operationVerify:
		spec.executable = "psql"
		spec.args = []string{"--no-psqlrc", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--command=" + postgresVerifySQL}
	case operationDump:
		spec.executable = "pg_dump"
		spec.args = []string{"--format=custom", "--no-owner", "--no-privileges"}
	case operationRestore:
		spec.executable = "pg_restore"
		spec.args = []string{"--no-owner", "--no-privileges", "--exit-on-error"}
	default:
		return processSpec{}, ErrInvalidInput
	}
	return spec, nil
}

func mysqlPlan(selected operation, target endpoint, work workspace, maria bool) (processSpec, error) {
	config := fmt.Sprintf("[client]\nhost=%s\nport=%s\nuser=%s\ndatabase=%s\npassword=\"%s\"\n", target.host, target.port, target.username, target.database, escapeMySQLQuoted(target.password))
	configPath, err := work.write("mysql.cnf", []byte(config))
	if err != nil {
		return processSpec{}, err
	}
	client, dumpClient := "mysql", "mysqldump"
	if maria {
		client, dumpClient = "mariadb", "mariadb-dump"
	}
	spec := processSpec{env: []string{"LC_ALL=C", "HOME=" + work.path}, configPaths: []string{configPath}}
	configArg := "--defaults-extra-file=" + configPath
	switch selected {
	case operationVerify:
		spec.executable = client
		spec.args = []string{configArg, "--batch", "--skip-column-names", "--execute=" + mysqlVerifySQL}
	case operationDump:
		spec.executable = dumpClient
		spec.args = []string{configArg, "--single-transaction", "--routines", "--events", "--triggers", "--hex-blob"}
	case operationRestore:
		spec.executable = client
		spec.args = []string{configArg, "--binary-mode=1"}
	default:
		return processSpec{}, ErrInvalidInput
	}
	return spec, nil
}

func mongodbPlan(selected operation, target endpoint, work workspace) (processSpec, error) {
	address := net.JoinHostPort(target.host, target.port)
	uri := &url.URL{Scheme: "mongodb", User: url.User(target.username), Host: address, Path: "/" + target.database}
	config, err := json.Marshal(struct {
		URI      string `json:"uri"`
		Password string `json:"password"`
	}{URI: uri.String(), Password: target.password})
	if err != nil {
		return processSpec{}, ErrWorkspace
	}
	configPath, err := work.write("mongodb.json", append(config, '\n'))
	if err != nil {
		return processSpec{}, err
	}
	spec := processSpec{env: []string{"LC_ALL=C"}, configPaths: []string{configPath}}
	configArg := "--config=" + configPath
	switch selected {
	case operationVerify:
		scriptPath, writeErr := work.write("verify.js", []byte(mongoVerifyScript+"\n"))
		if writeErr != nil {
			return processSpec{}, writeErr
		}
		spec.executable = "mongosh"
		spec.args = []string{"--quiet", "--nodb", "--file=" + scriptPath}
		spec.env = append(spec.env, "RAIBIT_MONGODB_CONFIG="+configPath)
		spec.configPaths = append(spec.configPaths, scriptPath)
	case operationDump:
		spec.executable = "mongodump"
		spec.args = []string{configArg, "--archive", "--gzip"}
	case operationRestore:
		spec.executable = "mongorestore"
		spec.args = []string{configArg, "--archive", "--gzip", "--drop"}
	default:
		return processSpec{}, ErrInvalidInput
	}
	return spec, nil
}

func escapePGPass(value string) string {
	return strings.NewReplacer("\\", "\\\\", ":", "\\:").Replace(value)
}

func escapeMySQLQuoted(value string) string {
	return strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(value)
}
