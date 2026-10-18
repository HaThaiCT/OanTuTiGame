use std::process::Command;
use arena_engine::{Coord, MapTopology, Piece, PieceType, PlayerSide, VictoryReason};
use arena_runner::dev_bot::{run_local_match, LocalManifest};

fn manifest() -> LocalManifest {
    let tiles: Vec<_> = (0..3).flat_map(|x| (0..3).map(move |y| (x, y))).collect();
    let map = MapTopology::try_new("local", 3, 3, &tiles, Coord::new(0, 0), Coord::new(2, 2)).unwrap();
    LocalManifest {
        map,
        pieces: vec![
            Piece { id: 1, owner: PlayerSide::White, piece_type: PieceType::Rock, pos: Coord::new(1, 2), is_alive: true },
            Piece { id: 2, owner: PlayerSide::Black, piece_type: PieceType::Paper, pos: Coord::new(1, 0), is_alive: true },
        ],
        max_ply: 50,
    }
}

const BOT: &str = r#"
import sys, json
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get('type') == 'INIT':
        print(json.dumps({'status': 'READY'}), flush=True)
    elif msg.get('type') == 'TURN':
        print(json.dumps({'action': 'MOVE', 'piece_id': 1, 'target': {'x': 2, 'y': 2}}), flush=True)
"#;

#[test]
fn real_python_processes_play_through_the_engine() {
    let white = {
        let mut command = Command::new("python3");
        command.arg("-c").arg(BOT);
        command
    };
    let black = {
        let mut command = Command::new("python3");
        command.arg("-c").arg(BOT);
        command
    };
    let outcome = run_local_match(manifest(), white, black).expect("local match runs");
    assert_eq!(outcome.winner, Some(PlayerSide::White));
    assert_eq!(outcome.reason, Some(VictoryReason::ThroneBreach));
}
