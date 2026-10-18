#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlayerSide {
    White,
    Black,
}

impl PlayerSide {
    pub fn opponent(self) -> Self {
        match self {
            Self::White => Self::Black,
            Self::Black => Self::White,
        }
    }

    pub fn to_str(self) -> &'static str {
        match self {
            Self::White => "WHITE",
            Self::Black => "BLACK",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PieceType {
    Rock,
    Scissors,
    Paper,
}

impl PieceType {
    /// Cyclic capture rule:
    /// Rock beats Scissors, Scissors beats Paper, Paper beats Rock.
    pub fn beats(self, other: Self) -> bool {
        matches!(
            (self, other),
            (Self::Rock, Self::Scissors)
                | (Self::Scissors, Self::Paper)
                | (Self::Paper, Self::Rock)
        )
    }

    pub fn to_str(self) -> &'static str {
        match self {
            Self::Rock => "ROCK",
            Self::Scissors => "SCISSORS",
            Self::Paper => "PAPER",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Coord {
    pub x: i32,
    pub y: i32,
}

impl Coord {
    pub fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    pub fn chebyshev_distance(self, other: Self) -> i32 {
        (self.x - other.x).abs().max((self.y - other.y).abs())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub id: u32,
    pub owner: PlayerSide,
    pub piece_type: PieceType,
    pub pos: Coord,
    pub is_alive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VictoryReason {
    Extinction,
    ThroneBreach,
    Stalemate,
    MaxTurnsMaterial,
    MaxTurnsProximity,
    MaxTurnsDraw,
    InvalidStartBothSides,
}

impl VictoryReason {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Extinction => "EXTINCTION",
            Self::ThroneBreach => "THRONE_BREACH",
            Self::Stalemate => "STALEMATE",
            Self::MaxTurnsMaterial => "MAX_TURNS_MATERIAL",
            Self::MaxTurnsProximity => "MAX_TURNS_PROXIMITY",
            Self::MaxTurnsDraw => "MAX_TURNS_DRAW",
            Self::InvalidStartBothSides => "INVALID_START_BOTH_SIDES",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Decisive,
    Draw,
    NoContest,
}

impl Disposition {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Decisive => "DECISIVE",
            Self::Draw => "DRAW",
            Self::NoContest => "NO_CONTEST",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VictoryOutcome {
    pub is_game_over: bool,
    pub winner: Option<PlayerSide>,
    pub reason: Option<VictoryReason>,
    pub disposition: Option<Disposition>,
}

impl VictoryOutcome {
    pub fn in_progress() -> Self {
        Self {
            is_game_over: false,
            winner: None,
            reason: None,
            disposition: None,
        }
    }

    pub fn decisive(winner: PlayerSide, reason: VictoryReason) -> Self {
        Self {
            is_game_over: true,
            winner: Some(winner),
            reason: Some(reason),
            disposition: Some(Disposition::Decisive),
        }
    }

    pub fn draw(reason: VictoryReason) -> Self {
        Self {
            is_game_over: true,
            winner: None,
            reason: Some(reason),
            disposition: Some(Disposition::Draw),
        }
    }

    pub fn no_contest(reason: VictoryReason) -> Self {
        Self {
            is_game_over: true,
            winner: None,
            reason: Some(reason),
            disposition: Some(Disposition::NoContest),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveAction {
    pub piece_id: u32,
    pub target_pos: Coord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureEvent {
    pub attacker_id: u32,
    pub victim_id: u32,
    pub victim_type: PieceType,
    pub pos: Coord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveOutcome {
    pub is_legal: bool,
    pub capture: Option<CaptureEvent>,
    pub victory: VictoryOutcome,
}
