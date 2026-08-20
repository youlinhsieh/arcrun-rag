package collector

import (
	"fmt"
	"time"
)

func pad(i int) string { return fmt.Sprintf("%03d", i) }

func nowFixed() time.Time { return time.Unix(1787100000, 0) }
