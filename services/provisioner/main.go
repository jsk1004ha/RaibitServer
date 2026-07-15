package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] == "help" {
		fmt.Println("raibitserver-provisioner: apply <managed-resource-manifest.json|yaml>")
		return
	}
	if os.Args[1] != "apply" || len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "expected apply <managed-resource-manifest-file>")
		os.Exit(1)
	}
	args := []string{"apply", "--server-side", "-f", os.Args[2]}
	fmt.Println("$ kubectl", args)
	if os.Getenv("RAIBITSERVER_EXECUTE") != "1" {
		return
	}
	cmd := exec.Command("kubectl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
