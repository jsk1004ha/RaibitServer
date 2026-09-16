package recoverydb

const (
	postgresBaselineSQL = `SELECT 'V' || chr(9) || current_setting('server_version_num'); SELECT 'D' || chr(9) || replace(encode(convert_to(concat_ws(chr(0), table_schema, table_name, column_name, data_type, ordinal_position::text, is_nullable), 'UTF8'), 'base64'), chr(10), '') FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position;`
	mysqlBaselineSQL    = `SELECT CONCAT('V', CHAR(9), REGEXP_SUBSTR(VERSION(), '^[0-9]+([.][0-9]+){0,3}')); SELECT CONCAT('D', CHAR(9), REPLACE(TO_BASE64(CONCAT_WS(CHAR(0), TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, ORDINAL_POSITION, IS_NULLABLE)), CHAR(10), '')) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION;`
	mongoBaselineScript = `const fs = require("fs"); const cfg = JSON.parse(fs.readFileSync(process.env.RAIBIT_MONGODB_CONFIG, "utf8")); const uri = new URL(cfg.uri); uri.password = cfg.password; const target = connect(uri.toString()); const version = target.version().match(/^[0-9]+(?:\.[0-9]+){0,3}/); if (!version) { quit(4); } print("V\t" + version[0]); const stable = (value) => { if (Array.isArray(value)) return value.map(stable); if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }; const collections = target.getCollectionInfos().sort((left, right) => left.name.localeCompare(right.name)); for (const info of collections) { const indexes = target.getCollection(info.name).getIndexes().sort((left, right) => left.name.localeCompare(right.name)); const descriptor = EJSON.stringify(stable({name: info.name, type: info.type, options: info.options, indexes}), {relaxed: false}); print("D\t" + Buffer.from(descriptor, "utf8").toString("base64")); }`
)

func buildBaselineProbe(selected engine, target endpoint, work workspace) (processSpec, error) {
	switch selected {
	case enginePostgreSQL:
		spec, err := postgresqlPlan(operationVerify, target, work)
		if err != nil {
			return processSpec{}, err
		}
		spec.args = []string{"--no-psqlrc", "--set=ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--command=" + postgresBaselineSQL}
		return spec, nil
	case engineMySQL, engineMariaDB:
		spec, err := mysqlPlan(operationVerify, target, work, selected == engineMariaDB)
		if err != nil {
			return processSpec{}, err
		}
		spec.args = []string{spec.args[0], "--batch", "--raw", "--skip-column-names", "--execute=" + mysqlBaselineSQL}
		return spec, nil
	case engineMongoDB:
		spec, err := mongodbPlan(operationDump, target, work)
		if err != nil {
			return processSpec{}, err
		}
		scriptPath, err := work.write("baseline.js", []byte(mongoBaselineScript+"\n"))
		if err != nil {
			return processSpec{}, err
		}
		spec.executable = "mongosh"
		spec.args = []string{"--quiet", "--nodb", "--file=" + scriptPath}
		spec.env = append(spec.env, "RAIBIT_MONGODB_CONFIG="+spec.configPaths[0])
		spec.configPaths = append(spec.configPaths, scriptPath)
		return spec, nil
	default:
		return processSpec{}, ErrInvalidInput
	}
}
