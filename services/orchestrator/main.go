package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] == "help" {
		fmt.Println("raibitserver-orchestrator: dry-run planning only; use cmd/orchestrator for the control-plane reconciler")
		return
	}
	if os.Args[1] != "apply" || len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "expected apply <manifest-file>")
		os.Exit(1)
	}
	args := []string{"apply", "--server-side", "-f", os.Args[2]}
	for i := 3; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--context", "--kubeconfig":
			if i+1 >= len(os.Args) {
				fmt.Fprintln(os.Stderr, "missing value for", os.Args[i])
				os.Exit(1)
			}
			args = append(args, os.Args[i], os.Args[i+1])
			i++
		}
	}
	fmt.Println("$ kubectl", args)
	if os.Getenv("RAIBITSERVER_EXECUTE") == "1" {
		fmt.Fprintln(os.Stderr, "legacy raw-manifest orchestrator is dry-run planning only; use cmd/orchestrator control-plane reconciler for live execution")
		os.Exit(1)
	}
}
