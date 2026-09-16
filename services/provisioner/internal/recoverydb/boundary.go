package recoverydb

import (
	"net"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func parseAction(raw string) (action, error) {
	switch raw {
	case "postgresql-verify":
		return action{enginePostgreSQL, operationVerify}, nil
	case "postgresql-dump":
		return action{enginePostgreSQL, operationDump}, nil
	case "postgresql-restore":
		return action{enginePostgreSQL, operationRestore}, nil
	case "mysql-verify":
		return action{engineMySQL, operationVerify}, nil
	case "mysql-dump":
		return action{engineMySQL, operationDump}, nil
	case "mysql-restore":
		return action{engineMySQL, operationRestore}, nil
	case "mariadb-verify":
		return action{engineMariaDB, operationVerify}, nil
	case "mariadb-dump":
		return action{engineMariaDB, operationDump}, nil
	case "mariadb-restore":
		return action{engineMariaDB, operationRestore}, nil
	case "mongodb-verify":
		return action{engineMongoDB, operationVerify}, nil
	case "mongodb-dump":
		return action{engineMongoDB, operationDump}, nil
	case "mongodb-restore":
		return action{engineMongoDB, operationRestore}, nil
	default:
		return action{}, ErrInvalidInput
	}
}

func parseEndpoint(lookup func(string) (string, bool), password []byte) (endpoint, error) {
	host, hostOK := lookup(envHost)
	port, portOK := lookup(envPort)
	database, databaseOK := lookup(envDatabase)
	username, usernameOK := lookup(envUsername)
	if !hostOK || !portOK || !databaseOK || !usernameOK {
		return endpoint{}, ErrInvalidInput
	}
	parsedPort, err := strconv.Atoi(port)
	if err != nil || parsedPort < 1 || parsedPort > 65535 || strconv.Itoa(parsedPort) != port {
		return endpoint{}, ErrInvalidInput
	}
	if !validHost(host) || !validIdentifier(database) || !validIdentifier(username) || !validCredential(password) {
		return endpoint{}, ErrInvalidInput
	}
	return endpoint{host: host, port: port, database: database, username: username, password: string(password)}, nil
}

func validHost(value string) bool {
	if len(value) < 1 || len(value) > 253 {
		return false
	}
	if strings.Contains(value, ":") {
		return net.ParseIP(value) != nil
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) < 1 || len(label) > 63 || !isASCIIAlphaNumeric(rune(label[0])) || !isASCIIAlphaNumeric(rune(label[len(label)-1])) {
			return false
		}
		for _, char := range label {
			if !isASCIIAlphaNumeric(char) && char != '-' {
				return false
			}
		}
	}
	return true
}

func validIdentifier(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if !isASCIIAlphaNumeric(char) && char != '_' && char != '-' && char != '.' {
			return false
		}
	}
	return true
}

func validCredential(value []byte) bool {
	if len(value) < 1 || len(value) > maxCredentialLen || !utf8.Valid(value) {
		return false
	}
	for _, char := range string(value) {
		if char == '\x00' || char == '\r' || char == '\n' || unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func isASCIIAlphaNumeric(char rune) bool {
	return char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
}
