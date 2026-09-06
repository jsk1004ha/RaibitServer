package providercontract

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

type Recovery struct {
	Host, Database, User, CredentialKey string
	Port                                uint16
	Index                               *uint16
	EnvironmentKeys                     []string
}

func SupportsRecovery(engine string) bool {
	switch strings.ToLower(strings.TrimSpace(engine)) {
	case "postgresql", "mysql", "mariadb", "mongodb", "redis", "valkey":
		return true
	default:
		return false
	}
}

func RecoveryFor(engine, name, namespace, resourceName string, spec map[string]any) (Recovery, error) {
	engine = strings.ToLower(strings.TrimSpace(engine))
	database := identifier(first(stringValue(spec, "databaseName"), resourceName, "app"))
	user := identifier(first(stringValue(spec, "username"), name+"-app"))
	host := name + "." + namespace + ".svc.cluster.local"
	result := Recovery{Host: host, Database: database, User: user}
	switch engine {
	case "postgresql":
		result.Port, result.CredentialKey = 5432, "PGPASSWORD"
		result.EnvironmentKeys = []string{"DATABASE_URL", "PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER", "POSTGRES_URL"}
	case "mysql":
		result.Port, result.CredentialKey = 3306, "MYSQL_PASSWORD"
		result.EnvironmentKeys = []string{"MYSQL_DATABASE", "MYSQL_HOST", "MYSQL_PASSWORD", "MYSQL_PORT", "MYSQL_URL", "MYSQL_USER"}
	case "mariadb":
		result.Port, result.CredentialKey = 3306, "MYSQL_PASSWORD"
		result.EnvironmentKeys = []string{"MARIADB_URL", "MYSQL_DATABASE", "MYSQL_HOST", "MYSQL_PASSWORD", "MYSQL_PORT", "MYSQL_URL", "MYSQL_USER"}
	case "mongodb":
		result.Port, result.CredentialKey = 27017, "MONGO_PASSWORD"
		result.EnvironmentKeys = []string{"MONGODB_URI", "MONGO_DATABASE", "MONGO_HOST", "MONGO_PASSWORD", "MONGO_URL", "MONGO_USER"}
	case "redis", "valkey":
		index := uint16(0)
		result.Port, result.Database, result.User, result.CredentialKey, result.Index = 6379, "", "default", "REDIS_PASSWORD", &index
		result.EnvironmentKeys = []string{"REDIS_HOST", "REDIS_PASSWORD", "REDIS_PORT", "REDIS_URL", "REDIS_USERNAME"}
		if engine == "valkey" {
			result.EnvironmentKeys = append(result.EnvironmentKeys, "VALKEY_URL")
			sort.Strings(result.EnvironmentKeys)
		}
	default:
		return Recovery{}, fmt.Errorf("engine %q has no recovery connection contract", engine)
	}
	return result, nil
}

func stringValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return value
}

func identifier(value string) string {
	value = strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
	value = strings.ReplaceAll(value, "-", "_")
	if value == "" || value == "item" {
		return "app"
	}
	if value[0] >= '0' && value[0] <= '9' {
		value = "app_" + value
	}
	if len(value) > 32 {
		value = value[:32]
	}
	return value
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
