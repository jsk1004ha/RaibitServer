package recoverycache

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

const maxRESPBytes = 16 << 20

type replyKind uint8

const (
	replySimple replyKind = iota + 1
	replyInteger
	replyBulk
	replyArray
)

type reply struct {
	kind    replyKind
	data    []byte
	integer int64
	array   []reply
}

type deadlineTransport interface {
	io.ReadWriteCloser
	SetDeadline(time.Time) error
}

type respClient struct {
	transport io.ReadWriteCloser
	reader    *bufio.Reader
	mu        sync.Mutex
}

func newRESPClient(transport io.ReadWriteCloser) *respClient {
	return &respClient{transport: transport, reader: bufio.NewReader(transport)}
}

func (c *respClient) command(ctx context.Context, arguments ...[]byte) (reply, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if deadline, ok := ctx.Deadline(); ok {
		if transport, ok := c.transport.(deadlineTransport); ok {
			if err := transport.SetDeadline(deadline); err != nil {
				return reply{}, ErrRESP
			}
		}
	}
	if err := writeCommand(c.transport, arguments); err != nil {
		return reply{}, ErrRESP
	}
	return readReply(c.reader, maxRESPBytes)
}

func (c *respClient) close() error {
	if err := c.transport.Close(); err != nil {
		return ErrRESP
	}
	return nil
}

func writeCommand(output io.Writer, arguments [][]byte) error {
	if len(arguments) == 0 || len(arguments) > 1024 {
		return ErrRESP
	}
	var buffer bytes.Buffer
	buffer.WriteByte('*')
	buffer.WriteString(strconv.Itoa(len(arguments)))
	buffer.WriteString("\r\n")
	for _, argument := range arguments {
		if len(argument) > maxRESPBytes {
			return ErrRESP
		}
		buffer.WriteByte('$')
		buffer.WriteString(strconv.Itoa(len(argument)))
		buffer.WriteString("\r\n")
		buffer.Write(argument)
		buffer.WriteString("\r\n")
	}
	if _, err := output.Write(buffer.Bytes()); err != nil {
		return ErrRESP
	}
	return nil
}

func readReply(reader *bufio.Reader, max int) (reply, error) {
	return readReplyDepth(reader, max, 0)
}

func readReplyDepth(reader *bufio.Reader, max, depth int) (reply, error) {
	if max < 1 || depth > 8 {
		return reply{}, ErrRESP
	}
	prefix, err := reader.ReadByte()
	if err != nil {
		return reply{}, ErrRESP
	}
	line, err := readLine(reader, max)
	if err != nil {
		return reply{}, err
	}
	switch prefix {
	case '+':
		return reply{kind: replySimple, data: bytes.Clone(line)}, nil
	case '-':
		return reply{}, ErrRESP
	case ':':
		value, err := strconv.ParseInt(string(line), 10, 64)
		if err != nil {
			return reply{}, ErrRESP
		}
		return reply{kind: replyInteger, integer: value}, nil
	case '$':
		return readBulk(reader, line, max)
	case '*':
		return readArray(reader, line, max, depth)
	default:
		return reply{}, ErrRESP
	}
}

func readLine(reader *bufio.Reader, max int) ([]byte, error) {
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) < 2 || len(line) > max || line[len(line)-2] != '\r' {
		return nil, ErrRESP
	}
	return bytes.Clone(line[:len(line)-2]), nil
}

func readBulk(reader *bufio.Reader, lengthLine []byte, max int) (reply, error) {
	length, err := strconv.ParseInt(string(lengthLine), 10, 64)
	if err != nil || length < -1 || length > int64(max) {
		return reply{}, ErrRESP
	}
	if length == -1 {
		return reply{kind: replyBulk}, nil
	}
	data := make([]byte, int(length)+2)
	if _, err := io.ReadFull(reader, data); err != nil || data[len(data)-2] != '\r' || data[len(data)-1] != '\n' {
		return reply{}, ErrRESP
	}
	return reply{kind: replyBulk, data: data[:len(data)-2]}, nil
}

func readArray(reader *bufio.Reader, lengthLine []byte, max, depth int) (reply, error) {
	length, err := strconv.ParseInt(string(lengthLine), 10, 32)
	if err != nil || length < 0 || length > 4096 {
		return reply{}, ErrRESP
	}
	items := make([]reply, int(length))
	for index := range items {
		items[index], err = readReplyDepth(reader, max, depth+1)
		if err != nil {
			return reply{}, err
		}
	}
	return reply{kind: replyArray, array: items}, nil
}

type netCacheDialer struct{}

func (netCacheDialer) dialTarget(ctx context.Context, config config, credential []byte) (cacheClient, error) {
	transport, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(config.host, strconv.FormatUint(uint64(config.port), 10)))
	if err != nil {
		return nil, ErrOperation
	}
	client := newRESPClient(transport)
	if err := authenticateAndSelect(ctx, client, config.username, credential, config.index); err != nil {
		if closeErr := client.close(); closeErr != nil {
			return nil, ErrOperation
		}
		return nil, err
	}
	return client, nil
}

func (netCacheDialer) dialSource(ctx context.Context, socket string, index uint16) (cacheClient, error) {
	transport, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, ErrOperation
	}
	client := newRESPClient(transport)
	if err := selectDatabase(ctx, client, index); err != nil {
		if closeErr := client.close(); closeErr != nil {
			return nil, ErrOperation
		}
		return nil, err
	}
	return client, nil
}

func authenticateAndSelect(ctx context.Context, client *respClient, username string, credential []byte, index uint16) error {
	auth, err := client.command(ctx, []byte("AUTH"), []byte(username), credential)
	if err != nil || auth.kind != replySimple || !bytes.Equal(auth.data, []byte("OK")) {
		return ErrOperation
	}
	return selectDatabase(ctx, client, index)
}

func selectDatabase(ctx context.Context, client *respClient, index uint16) error {
	selected, err := client.command(ctx, []byte("SELECT"), []byte(strconv.FormatUint(uint64(index), 10)))
	if err != nil || selected.kind != replySimple || !bytes.Equal(selected.data, []byte("OK")) {
		return ErrOperation
	}
	return nil
}

type cacheDialer interface {
	dialTarget(context.Context, config, []byte) (cacheClient, error)
	dialSource(context.Context, string, uint16) (cacheClient, error)
}

type cacheClient interface {
	ping(context.Context) error
	close() error
	bgSave(context.Context) error
	lastSave(context.Context) (int64, error)
	dbSize(context.Context) (int64, error)
	usedMemory(context.Context) (int64, error)
	ready(context.Context) error
	databaseIndexes(context.Context) ([]uint16, error)
	version(context.Context, engine) (string, error)
	set(context.Context, []byte, []byte, time.Duration, bool) error
	get(context.Context, []byte) ([]byte, error)
	scan(context.Context, string, int) (string, [][]byte, error)
	migrate(context.Context, config, []byte, [][]byte, time.Duration) error
	snapshot(context.Context, []byte) (keySnapshot, error)
	delete(context.Context, []byte) error
}
