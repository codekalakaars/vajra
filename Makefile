.PHONY: build run demo install

build:
	cargo build
	sudo setcap cap_sys_admin+ep target/debug/vajra
	sudo setcap -r target/debug/vajra-run 2>/dev/null || true

run: build
	./target/debug/vajra launch

demo:
	./scripts/demo.sh

# vajra needs CAP_SYS_ADMIN for namespaces; vajra-run must stay uncapped
# (the kernel refuses to exec setcap binaries under NO_NEW_PRIVS).
install:
	cargo build --release
	sudo install -m755 target/release/vajra target/release/vajra-run /usr/local/bin/
	sudo setcap cap_sys_admin+ep /usr/local/bin/vajra
