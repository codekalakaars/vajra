.PHONY: build run

build:
	cargo build
	sudo setcap cap_sys_admin+ep target/debug/vajra
	sudo setcap -r target/debug/vajra-run 2>/dev/null || true

run: build
	./target/debug/vajra launch
