package backup

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func Test_ArtifactContract_when_placeholder(t *testing.T) {
	// Given: the backup package previously exported only a scheduling Policy.
	packages, err := parser.ParseDir(token.NewFileSet(), ".", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{"ParseBundle": false, "NewService": false, "Upload": false, "Verify": false, "Cleanup": false}
	// When: inspecting the callable artifact boundary, not documentation text.
	for _, file := range packages["backup"].Files {
		for _, decl := range file.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok {
				if _, exists := wanted[fn.Name.Name]; exists {
					wanted[fn.Name.Name] = true
				}
			}
		}
	}
	// Then: every required operation must actually exist.
	for name, found := range wanted {
		if !found {
			t.Errorf("required artifact operation absent: %s", name)
		}
	}
}
