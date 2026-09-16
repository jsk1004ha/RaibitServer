package domain

import (
	"context"
	"errors"
	"fmt"
	"net"
)

type NetResolver struct {
	resolver *net.Resolver
}

func NewNetResolver(resolver *net.Resolver) NetResolver {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	return NetResolver{resolver: resolver}
}

func (r NetResolver) LookupTXT(ctx context.Context, name string) (TXTAnswer, error) {
	records, err := r.resolver.LookupTXT(ctx, name)
	if err == nil {
		return TXTAnswer{Records: records, Authoritative: true}, nil
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return TXTAnswer{Authoritative: true}, nil
	}
	return TXTAnswer{}, fmt.Errorf("%w: %v", ErrDNSRetryable, err)
}
