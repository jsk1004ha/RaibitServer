package store

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// Only the five-character SQLSTATE crosses this boundary, never backend messages or values.
type recoveryStorageFailure struct{ code string }

func (e recoveryStorageFailure) Error() string { return "RECOVERY_STORAGE_FAILURE:" + e.code }
func (e recoveryStorageFailure) Unwrap() error { return ErrRecoveryStorage }

func recoveryDBFailure(err error) error {
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) && len(postgres.Code) == 5 {
		for _, c := range postgres.Code {
			if (c < 'A' || c > 'Z') && (c < '0' || c > '9') {
				return ErrRecoveryStorage
			}
		}
		return recoveryStorageFailure{postgres.Code}
	}
	return ErrRecoveryStorage
}
