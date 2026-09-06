package safeerror

// Error keeps errors.Is/As causality without exposing backend bodies, DSNs or paths.
type Error struct {
	Operation string
	Cause     error
}

func (e *Error) Error() string { return e.Operation + " failed" }
func (e *Error) Unwrap() error { return e.Cause }
