module github.com/agentic-wiki/wiki-shell

go 1.24

require (
	github.com/agentic-wiki/wiki v0.23.1
	github.com/fsnotify/fsnotify v1.10.1
)

require (
	github.com/BurntSushi/toml v1.6.0 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/sys v0.13.0 // indirect
)

// For now, wiki is built from its checkout beside this repo.
replace github.com/agentic-wiki/wiki => ../wiki
