package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	buildplan "github.com/raibitserver/builder/internal/build"
	"github.com/raibitserver/builder/internal/controlplane"
	"github.com/raibitserver/builder/internal/worker"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	env := environment()
	if err := validateRoleEnvironment(env); err != nil {
		fmt.Fprintf(os.Stderr, "builder role configuration failed: %v\n", err)
		os.Exit(1)
	}
	role := strings.ToLower(strings.TrimSpace(env["RAIBITSERVER_BUILDER_ROLE"]))
	if role == "dispatcher" {
		if err := runDispatcher(ctx, env); err != nil {
			fmt.Fprintf(os.Stderr, "builder dispatcher failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if role == "executor" {
		if err := runExecutor(ctx, env); err != nil {
			fmt.Fprintf(os.Stderr, "builder executor failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	stateFile := worker.StateFileFromEnv()
	if stateFile != "" {
		builder := worker.New(controlplane.NewFileStore(stateFile), worker.OSRunner{}, worker.ConfigFromEnv())
		result, err := builder.RunOnce(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "builder workflow failed: %v\n", err)
			os.Exit(1)
		}
		_ = json.NewEncoder(os.Stdout).Encode(result)
		return
	}
	if dsn := controlplane.PostgresDSNFromEnv(env); dsn != "" {
		store, closeStore, err := controlplane.OpenPostgresStore(ctx, dsn)
		if err != nil {
			fmt.Fprintf(os.Stderr, "builder PostgreSQL control-plane store failed: %v\n", err)
			os.Exit(1)
		}
		defer closeStore()
		builder := worker.New(store, worker.OSRunner{}, worker.ConfigFromEnv())
		if runOnceEnabled() {
			result, runErr := builder.RunOnce(ctx)
			if runErr != nil {
				fmt.Fprintf(os.Stderr, "builder workflow failed: %v\n", runErr)
				os.Exit(1)
			}
			_ = json.NewEncoder(os.Stdout).Encode(result)
			return
		}
		pollInterval := durationSecondsEnv("RAIBITSERVER_RECONCILE_INTERVAL_SECONDS", 5*time.Second)
		for {
			result, err := builder.RunOnce(ctx)
			if err != nil {
				fmt.Fprintf(os.Stderr, "builder workflow failed: %v\n", err)
			} else {
				_ = json.NewEncoder(os.Stdout).Encode(result)
			}
			timer := time.NewTimer(pollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}

	mode := os.Getenv("RAIBITSERVER_BUILD_MODE")
	if mode == "" {
		mode = "auto"
	}
	plan := buildplan.Plan{Mode: mode, Source: os.Getenv("RAIBITSERVER_SOURCE"), Image: os.Getenv("RAIBITSERVER_IMAGE")}
	if err := plan.Validate(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "builder plan invalid: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("raibitserver builder mode=%s action=build-or-verify-image state=env-only\n", plan.Mode)
}

func runDispatcher(ctx context.Context, env map[string]string) error {
	dsn := controlplane.PostgresDSNFromEnv(env)
	if dsn == "" {
		return errors.New("dispatcher requires the explicit control-plane PostgreSQL store")
	}
	store, closeStore, err := controlplane.OpenPostgresStore(ctx, dsn)
	if err != nil {
		return fmt.Errorf("open PostgreSQL control-plane store: %w", err)
	}
	defer closeStore()
	tlsConfig, err := controlplane.NewDispatcherTLSConfig(
		env["RAIBITSERVER_DISPATCH_CLIENT_CA_FILE"],
		env["RAIBITSERVER_DISPATCH_SERVER_CERT_FILE"],
		env["RAIBITSERVER_DISPATCH_SERVER_KEY_FILE"],
	)
	if err != nil {
		return err
	}
	sessionTTL := durationSecondsMap(env, "RAIBITSERVER_DISPATCH_SESSION_TTL_SECONDS", 15*time.Minute)
	githubCredentials, err := controlplane.NewGitHubAppCredentialIssuer(controlplane.GitHubAppCredentialIssuerConfig{
		AppID:          env["RAIBITSERVER_GITHUB_APP_ID"],
		PrivateKeyFile: env["RAIBITSERVER_GITHUB_APP_PRIVATE_KEY_FILE"],
		APIURL:         env["RAIBITSERVER_GITHUB_API_URL"],
	})
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              mapValueOr(env, "RAIBITSERVER_DISPATCH_ADDR", ":8443"),
		Handler:           controlplane.NewDispatchHandlerWithGitHubCredentials(store, sessionTTL, githubCredentials),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       35 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	err = server.ListenAndServeTLS("", "")
	if errors.Is(err, http.ErrServerClosed) {
		<-shutdownDone
		return nil
	}
	return err
}

func runExecutor(ctx context.Context, env map[string]string) error {
	store, err := controlplane.NewRemoteStore(controlplane.RemoteStoreConfig{
		BaseURL:               env["RAIBITSERVER_CONTROL_PLANE_REMOTE_URL"],
		CAFile:                env["RAIBITSERVER_DISPATCH_CA_FILE"],
		ClientCertificateFile: env["RAIBITSERVER_DISPATCH_CLIENT_CERT_FILE"],
		ClientKeyFile:         env["RAIBITSERVER_DISPATCH_CLIENT_KEY_FILE"],
		Timeout:               durationSecondsMap(env, "RAIBITSERVER_DISPATCH_REQUEST_TIMEOUT_SECONDS", 30*time.Second),
	})
	if err != nil {
		return err
	}
	builder := worker.New(store, worker.OSRunner{}, worker.ConfigFromEnv())
	result, err := builder.RunOnce(ctx)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func validateRoleEnvironment(env map[string]string) error {
	role := strings.ToLower(strings.TrimSpace(env["RAIBITSERVER_BUILDER_ROLE"]))
	production := envBool(env["RAIBITSERVER_PRODUCTION"]) || strings.EqualFold(strings.TrimSpace(env["RAIBITSERVER_ENV"]), "production")
	if production && role != "dispatcher" && role != "executor" {
		return errors.New("production builder role must be dispatcher or executor; combined DB-and-build execution is forbidden")
	}
	switch role {
	case "":
		return nil
	case "dispatcher":
		if envBool(env["RAIBITSERVER_EXECUTE"]) {
			return errors.New("trusted dispatcher must not execute tenant build commands")
		}
		if controlplane.PostgresDSNFromEnv(env) == "" {
			return errors.New("dispatcher requires an explicit control-plane PostgreSQL credential")
		}
	case "executor":
		for _, key := range []string{"DATABASE_URL", "RAIBITSERVER_CONTROL_PLANE_DATABASE_URL"} {
			if strings.TrimSpace(env[key]) != "" {
				return errors.New("builder executor must not receive database credentials")
			}
		}
		if strings.TrimSpace(env["RAIBITSERVER_GITHUB_APP_PRIVATE_KEY_FILE"]) != "" {
			return errors.New("builder executor must not receive the GitHub App private key")
		}
		if strings.TrimSpace(env["RAIBITSERVER_CONTROL_PLANE_REMOTE_URL"]) == "" {
			return errors.New("builder executor requires the remote dispatcher URL")
		}
		if production && (!envBool(env["RAIBITSERVER_RUN_ONCE"]) || env["RAIBITSERVER_BUILDER_ISOLATION"] != "single-job-pod") {
			return errors.New("production builder executor requires one disposable single-job pod")
		}
	default:
		return fmt.Errorf("unsupported builder role %q", role)
	}
	return nil
}

func runOnceEnabled() bool {
	return os.Getenv("RAIBITSERVER_RUN_ONCE") == "1" && os.Getenv("RAIBITSERVER_BUILDER_ISOLATION") == "single-job-pod"
}

func durationSecondsEnv(name string, fallback time.Duration) time.Duration {
	seconds, err := strconv.Atoi(os.Getenv(name))
	if err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func durationSecondsMap(env map[string]string, name string, fallback time.Duration) time.Duration {
	seconds, err := strconv.Atoi(env[name])
	if err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func mapValueOr(env map[string]string, name, fallback string) string {
	if value := strings.TrimSpace(env[name]); value != "" {
		return value
	}
	return fallback
}

func envBool(value string) bool {
	value = strings.TrimSpace(value)
	return value == "1" || strings.EqualFold(value, "true") || strings.EqualFold(value, "yes")
}

func environment() map[string]string {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}
