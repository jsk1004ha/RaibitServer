package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
)

type expression struct{ Name, Expression string }
type selector struct {
	MatchLabels      map[string]string
	MatchExpressions []struct {
		Key, Operator string
		Values        []string
	}
}
type constraints struct {
	ObjectSelector, NamespaceSelector selector
	ResourceRules                     []struct{ APIGroups, APIVersions, Operations, Resources []string }
}
type policy struct {
	Metadata struct{ Name string }
	Spec     struct {
		FailurePolicy                           string
		MatchConstraints                        constraints
		MatchConditions, Variables, Validations []expression
	}
}
type binding struct {
	Spec struct {
		PolicyName        string
		ValidationActions []string
		MatchResources    constraints
	}
}
type requestCase struct {
	Name       string
	Activation map[string]any
}
type observation struct {
	Allowed bool     `json:"allowed"`
	Denied  []string `json:"denied"`
	Skipped []string `json:"skipped"`
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value || candidate == "*" {
			return true
		}
	}
	return false
}

func matchesSelector(s selector, object any) bool {
	if len(s.MatchLabels) == 0 && len(s.MatchExpressions) == 0 {
		return true
	}
	m, ok := object.(map[string]any)
	if !ok {
		return false
	}
	metadata, _ := m["metadata"].(map[string]any)
	labels, _ := metadata["labels"].(map[string]any)
	for key, value := range s.MatchLabels {
		if labels[key] != value {
			return false
		}
	}
	for _, requirement := range s.MatchExpressions {
		value, present := labels[requirement.Key].(string)
		switch requirement.Operator {
		case "Exists":
			if !present {
				return false
			}
		case "DoesNotExist":
			if present {
				return false
			}
		case "In":
			if !present || !contains(requirement.Values, value) {
				return false
			}
		case "NotIn":
			if present && contains(requirement.Values, value) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func matches(c constraints, activation map[string]any) bool {
	if !matchesSelector(c.NamespaceSelector, activation["namespaceObject"]) {
		return false
	}
	if !matchesSelector(c.ObjectSelector, activation["object"]) && !matchesSelector(c.ObjectSelector, activation["oldObject"]) {
		return false
	}
	if len(c.ResourceRules) == 0 {
		return true
	}
	request := activation["request"].(map[string]any)
	resource := request["resource"].(map[string]any)
	for _, rule := range c.ResourceRules {
		if contains(rule.APIGroups, resource["group"].(string)) && contains(rule.APIVersions, resource["version"].(string)) && contains(rule.Operations, request["operation"].(string)) && contains(rule.Resources, resource["resource"].(string)) {
			return true
		}
	}
	return false
}

var variablePattern = regexp.MustCompile(`variables\.([A-Za-z][A-Za-z0-9_]*)`)

func evaluate(env *cel.Env, source string, activation map[string]any, variables []expression) (bool, error) {
	for round := 0; variablePattern.MatchString(source) && round <= len(variables); round++ {
		source = variablePattern.ReplaceAllStringFunc(source, func(match string) string {
			for _, variable := range variables {
				if match == "variables."+variable.Name {
					return "(" + variable.Expression + ")"
				}
			}
			return match
		})
	}
	ast, issues := env.Compile(source)
	if issues != nil && issues.Err() != nil {
		return false, issues.Err()
	}
	program, err := env.Program(ast)
	if err != nil {
		return false, err
	}
	value, _, err := program.Eval(activation)
	if err != nil {
		return false, err
	}
	return value == types.True, nil
}

func normalize(value any) any {
	switch typed := value.(type) {
	case float64:
		if typed == float64(int64(typed)) {
			return int64(typed)
		}
		return typed
	case []any:
		for index, child := range typed {
			typed[index] = normalize(child)
		}
		return typed
	case map[string]any:
		for key, child := range typed {
			typed[key] = normalize(child)
		}
		return typed
	default:
		return typed
	}
}

func main() {
	var input struct {
		Policies []policy
		Bindings []binding
		Cases    []requestCase
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	env, err := cel.NewEnv(cel.Variable("request", cel.DynType), cel.Variable("object", cel.DynType), cel.Variable("oldObject", cel.DynType), cel.Variable("namespaceObject", cel.DynType))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	results := make([]observation, 0, len(input.Cases))
	for _, scenario := range input.Cases {
		activation := normalize(scenario.Activation).(map[string]any)
		result := observation{Allowed: true, Denied: []string{}, Skipped: []string{}}
		for _, p := range input.Policies {
			bound := false
			for _, b := range input.Bindings {
				if b.Spec.PolicyName == p.Metadata.Name && contains(b.Spec.ValidationActions, "Deny") && matches(b.Spec.MatchResources, activation) {
					bound = true
				}
			}
			if !bound || !matches(p.Spec.MatchConstraints, activation) {
				continue
			}
			skip, conditionErrors := false, []string{}
			for _, condition := range p.Spec.MatchConditions {
				ok, err := evaluate(env, condition.Expression, activation, p.Spec.Variables)
				if err != nil {
					conditionErrors = append(conditionErrors, err.Error())
				} else if !ok {
					skip = true
				}
			}
			if skip {
				result.Skipped = append(result.Skipped, p.Metadata.Name)
				continue
			}
			if len(conditionErrors) > 0 {
				if p.Spec.FailurePolicy != "Ignore" {
					result.Denied = append(result.Denied, p.Metadata.Name+": match error: "+strings.Join(conditionErrors, "; "))
				}
				continue
			}
			for index, validation := range p.Spec.Validations {
				ok, err := evaluate(env, validation.Expression, activation, p.Spec.Variables)
				if err != nil {
					if p.Spec.FailurePolicy != "Ignore" {
						result.Denied = append(result.Denied, fmt.Sprintf("%s[%d] error: %v", p.Metadata.Name, index, err))
					}
				} else if !ok {
					result.Denied = append(result.Denied, fmt.Sprintf("%s[%d] false", p.Metadata.Name, index))
				}
			}
		}
		result.Allowed = len(result.Denied) == 0
		results = append(results, result)
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
