package recoveryreceipt

const (
	MaxBytes           = 4096
	TerminationLogPath = "/dev/termination-log"
	WireVersion        = "raibit-recovery-receipt/v1"
)

type Engine string

const (
	EnginePostgreSQL Engine = "postgresql"
	EngineMySQL      Engine = "mysql"
	EngineMariaDB    Engine = "mariadb"
	EngineMongoDB    Engine = "mongodb"
	EngineRedis      Engine = "redis"
	EngineValkey     Engine = "valkey"
)

type Direction string

const (
	DirectionDump    Direction = "dump"
	DirectionRestore Direction = "restore"
)

type Action string

const (
	ActionPostgreSQLDump    Action = "postgresql-dump"
	ActionPostgreSQLRestore Action = "postgresql-restore"
	ActionMySQLDump         Action = "mysql-dump"
	ActionMySQLRestore      Action = "mysql-restore"
	ActionMariaDBDump       Action = "mariadb-dump"
	ActionMariaDBRestore    Action = "mariadb-restore"
	ActionMongoDBDump       Action = "mongodb-dump"
	ActionMongoDBRestore    Action = "mongodb-restore"
	ActionRedisBackup       Action = "redis-backup"
	ActionRedisRestore      Action = "redis-restore"
	ActionValkeyBackup      Action = "valkey-backup"
	ActionValkeyRestore     Action = "valkey-restore"
)

func (a Action) Engine() Engine {
	switch a {
	case ActionPostgreSQLDump, ActionPostgreSQLRestore:
		return EnginePostgreSQL
	case ActionMySQLDump, ActionMySQLRestore:
		return EngineMySQL
	case ActionMariaDBDump, ActionMariaDBRestore:
		return EngineMariaDB
	case ActionMongoDBDump, ActionMongoDBRestore:
		return EngineMongoDB
	case ActionRedisBackup, ActionRedisRestore:
		return EngineRedis
	case ActionValkeyBackup, ActionValkeyRestore:
		return EngineValkey
	default:
		return ""
	}
}

func (a Action) Direction() Direction {
	switch a {
	case ActionPostgreSQLDump, ActionMySQLDump, ActionMariaDBDump, ActionMongoDBDump, ActionRedisBackup, ActionValkeyBackup:
		return DirectionDump
	case ActionPostgreSQLRestore, ActionMySQLRestore, ActionMariaDBRestore, ActionMongoDBRestore, ActionRedisRestore, ActionValkeyRestore:
		return DirectionRestore
	default:
		return ""
	}
}

type BaselineSpec struct {
	SchemaSHA256 string
	DataSHA256   string
	RecordCount  uint64
}

type VerificationSpec struct {
	Version bool
	Schema  bool
	// DecodedArtifact proves digest and structural validation of the decoded artifact; it does not claim row equality.
	DecodedArtifact bool
	Sentinel        *bool
	TTL             *bool
}

type Spec struct {
	Engine        Engine
	Action        Action
	Direction     Direction
	DecodedBytes  uint64
	DecodedSHA256 string
	Baseline      *BaselineSpec
	Verification  VerificationSpec
}

type Receipt struct{ spec Spec }

func (r Receipt) Engine() Engine        { return r.spec.Engine }
func (r Receipt) Action() Action        { return r.spec.Action }
func (r Receipt) Direction() Direction  { return r.spec.Direction }
func (r Receipt) DecodedBytes() uint64  { return r.spec.DecodedBytes }
func (r Receipt) DecodedSHA256() string { return r.spec.DecodedSHA256 }
func (r Receipt) Baseline() BaselineSpec {
	if r.spec.Baseline == nil {
		return BaselineSpec{}
	}
	return *r.spec.Baseline
}
func (r Receipt) Verification() VerificationSpec {
	return cloneVerification(r.spec.Verification)
}

func cloneVerification(source VerificationSpec) VerificationSpec {
	result := source
	if source.Sentinel != nil {
		value := *source.Sentinel
		result.Sentinel = &value
	}
	if source.TTL != nil {
		value := *source.TTL
		result.TTL = &value
	}
	return result
}
