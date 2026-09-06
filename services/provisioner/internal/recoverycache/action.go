package recoverycache

type engine uint8

const (
	engineRedis engine = iota + 1
	engineValkey
)

type operation uint8

const (
	operationBackup operation = iota + 1
	operationRestore
	operationVerify
)

type Action struct {
	value     string
	engine    engine
	operation operation
}

func ParseAction(args []string) (Action, error) {
	return parseAction(args)
}

func parseAction(args []string) (Action, error) {
	if len(args) != 1 {
		return Action{}, ErrAction
	}
	switch args[0] {
	case "redis-backup":
		return Action{value: args[0], engine: engineRedis, operation: operationBackup}, nil
	case "redis-restore":
		return Action{value: args[0], engine: engineRedis, operation: operationRestore}, nil
	case "redis-verify":
		return Action{value: args[0], engine: engineRedis, operation: operationVerify}, nil
	case "valkey-backup":
		return Action{value: args[0], engine: engineValkey, operation: operationBackup}, nil
	case "valkey-restore":
		return Action{value: args[0], engine: engineValkey, operation: operationRestore}, nil
	case "valkey-verify":
		return Action{value: args[0], engine: engineValkey, operation: operationVerify}, nil
	default:
		return Action{}, ErrAction
	}
}

func (a Action) String() string { return a.value }
