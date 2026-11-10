use std::cell::RefCell;
use std::collections::HashMap;

use snow::{Builder, HandshakeState, TransportState};

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_random(ptr: *mut u8, len: usize);
}

#[no_mangle]
pub extern "C" fn ab_getrandom(buf: *mut u8, len: usize) -> u32 {
    unsafe { host_random(buf, len) };
    0
}

fn my_getrandom(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    unsafe { host_random(buf.as_mut_ptr(), buf.len()) };
    Ok(())
}
getrandom::register_custom_getrandom!(my_getrandom);

enum Conn {
    Hs(HandshakeState),
    Tx(TransportState),
}

thread_local! {
    static REG: RefCell<HashMap<u32, Conn>> = RefCell::new(HashMap::new());
    static NEXT: RefCell<u32> = RefCell::new(1);
}

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(size);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(ptr, 0, size)) };
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Pattern ids are part of the ABI. An unknown id must fail instead of silently
/// falling back to another pattern, which would change the handshake's guarantees.
fn params(id: u32) -> Option<snow::params::NoiseParams> {
    let name = match id {
        0 => "Noise_XXpsk3_25519_ChaChaPoly_SHA256",
        1 => "Noise_IK_25519_ChaChaPoly_SHA256",
        _ => return None,
    };
    name.parse().ok()
}

/// Generate a static X25519 keypair. Returns private(32) then public(32) at out_priv/out_pub.
#[no_mangle]
pub extern "C" fn gen_keypair(out_priv: *mut u8, out_pub: *mut u8) -> i32 {
    let Some(p) = params(1) else { return -1 };
    match Builder::new(p).generate_keypair() {
        Ok(kp) => {
            unsafe {
                std::ptr::copy_nonoverlapping(kp.private.as_ptr(), out_priv, 32);
                std::ptr::copy_nonoverlapping(kp.public.as_ptr(), out_pub, 32);
            }
            0
        }
        Err(_) => -1,
    }
}

fn call_io<F>(h: u32, f: F, out: *mut u8, cap: usize) -> i32
where
    F: FnOnce(&mut Conn, *mut u8, usize) -> Result<usize, ()>,
{
    REG.with(|r| {
        let mut reg = r.borrow_mut();
        let conn = match reg.get_mut(&h) {
            Some(c) => c,
            None => return -1,
        };
        match f(conn, out, cap) {
            Ok(n) => n as i32,
            Err(_) => -2,
        }
    })
}

/// Create a handshake. local_priv may be null for a fresh keypair (XX).
/// Callers must pass exactly 32 bytes for each key; the ABI has no key lengths.
#[no_mangle]
pub extern "C" fn hs_new(
    pattern: u32,
    initiator: u32,
    local_priv: *const u8,
    remote_pub: *const u8,
    psk: *const u8,
    prologue: *const u8,
    prologue_len: usize,
) -> i32 {
    let Some(p) = params(pattern) else { return -1 };
    let mut b = Builder::new(p);
    if pattern == 0 && !psk.is_null() {
        b = b.psk(3, unsafe { slice(psk, 32) });
    }
    if !local_priv.is_null() {
        b = b.local_private_key(unsafe { slice(local_priv, 32) });
    }
    if !remote_pub.is_null() {
        b = b.remote_public_key(unsafe { slice(remote_pub, 32) });
    }
    if !prologue.is_null() {
        b = b.prologue(unsafe { slice(prologue, prologue_len) });
    }
    let hs = if initiator != 0 { b.build_initiator() } else { b.build_responder() };
    match hs {
        Ok(hs) => {
            let id = NEXT.with(|n| {
                let mut n = n.borrow_mut();
                let id = *n;
                *n += 1;
                id
            });
            REG.with(|r| r.borrow_mut().insert(id, Conn::Hs(hs)));
            id as i32
        }
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn hs_write(h: u32, in_ptr: *const u8, in_len: usize, out: *mut u8, cap: usize) -> i32 {
    let payload = unsafe { slice(in_ptr, in_len) }.to_vec();
    call_io(h, |c, out, cap| match c {
        Conn::Hs(hs) => {
            let buf = unsafe { std::slice::from_raw_parts_mut(out, cap) };
            hs.write_message(&payload, buf).map_err(|_| ())
        }
        _ => Err(()),
    }, out, cap)
}

#[no_mangle]
pub extern "C" fn hs_read(h: u32, in_ptr: *const u8, in_len: usize, out: *mut u8, cap: usize) -> i32 {
    let msg = unsafe { slice(in_ptr, in_len) }.to_vec();
    call_io(h, |c, out, cap| match c {
        Conn::Hs(hs) => {
            let buf = unsafe { std::slice::from_raw_parts_mut(out, cap) };
            hs.read_message(&msg, buf).map_err(|_| ())
        }
        _ => Err(()),
    }, out, cap)
}

#[no_mangle]
pub extern "C" fn hs_finished(h: u32) -> i32 {
    REG.with(|r| match r.borrow().get(&h) {
        Some(Conn::Hs(hs)) => hs.is_handshake_finished() as i32,
        _ => -1,
    })
}

#[no_mangle]
pub extern "C" fn hs_remote_static(h: u32, out: *mut u8) -> i32 {
    REG.with(|r| match r.borrow().get(&h) {
        Some(Conn::Hs(hs)) => match hs.get_remote_static() {
            Some(k) => {
                unsafe { std::ptr::copy_nonoverlapping(k.as_ptr(), out, 32) };
                32
            }
            None => 0,
        },
        _ => -1,
    })
}

#[no_mangle]
pub extern "C" fn hs_into_transport(h: u32) -> i32 {
    REG.with(|r| {
        let mut reg = r.borrow_mut();
        let conn = match reg.remove(&h) {
            Some(c) => c,
            None => return -1,
        };
        match conn {
            Conn::Hs(hs) => match hs.into_transport_mode() {
                Ok(tx) => {
                    reg.insert(h, Conn::Tx(tx));
                    0
                }
                Err(_) => -2,
            },
            other => {
                reg.insert(h, other);
                -3
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn enc(h: u32, in_ptr: *const u8, in_len: usize, out: *mut u8, cap: usize) -> i32 {
    let p = unsafe { slice(in_ptr, in_len) }.to_vec();
    call_io(h, |c, out, cap| match c {
        Conn::Tx(tx) => {
            let buf = unsafe { std::slice::from_raw_parts_mut(out, cap) };
            tx.write_message(&p, buf).map_err(|_| ())
        }
        _ => Err(()),
    }, out, cap)
}

#[no_mangle]
pub extern "C" fn dec(h: u32, in_ptr: *const u8, in_len: usize, out: *mut u8, cap: usize) -> i32 {
    let c = unsafe { slice(in_ptr, in_len) }.to_vec();
    call_io(h, |conn, out, cap| match conn {
        Conn::Tx(tx) => {
            let buf = unsafe { std::slice::from_raw_parts_mut(out, cap) };
            tx.read_message(&c, buf).map_err(|_| ())
        }
        _ => Err(()),
    }, out, cap)
}

#[no_mangle]
pub extern "C" fn conn_free(h: u32) {
    REG.with(|r| {
        r.borrow_mut().remove(&h);
    });
}

#[no_mangle]
pub extern "C" fn ab_version() -> u32 {
    1
}
