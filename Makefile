.PHONY: build run

build:
	cargo build
	sudo setcap cap_sys_admin+ep target/debug/vajra

run: build
	./target/debug/vajra launch
