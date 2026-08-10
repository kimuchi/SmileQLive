/**
 * Supabase の public スキーマ型定義。
 *
 * `supabase gen types typescript` の出力形式へ合わせて手書きしている。
 * マイグレーションを変更したら本ファイルも更新すること。
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type QuizStatus = 'draft' | 'published' | 'archived';
export type QuestionTypeDb = 'choice' | 'number';
export type NumberJudgementModeDb = 'exact' | 'absolute_tolerance' | 'range';
export type RoomPhaseDb =
  | 'lobby'
  | 'question_ready'
  | 'question_open'
  | 'question_locked'
  | 'answer_revealed'
  | 'scoreboard'
  | 'finished';
export type RoomMemberRole = 'host' | 'presenter' | 'participant';

export type ProfileRow = {
  id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

export type MediaAssetRow = {
  id: string;
  owner_id: string;
  bucket: string;
  object_path: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  created_at: string;
};

export type QuizRow = {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  status: QuizStatus;
  show_leaderboard: boolean;
  sound_theme: string;
  created_at: string;
  updated_at: string;
};

export type QuestionRow = {
  id: string;
  quiz_id: string;
  position: number;
  question_type: QuestionTypeDb;
  question_text: string | null;
  question_image_asset_id: string | null;
  question_image_alt: string | null;
  reveal_image_asset_id: string | null;
  reveal_image_alt: string | null;
  explanation: string | null;
  time_limit_seconds: number;
  points: number;
  number_mode: NumberJudgementModeDb | null;
  number_correct_value: string | null;
  number_tolerance: string | null;
  number_min_value: string | null;
  number_max_value: string | null;
  number_unit: string | null;
  number_decimal_places: number;
  created_at: string;
  updated_at: string;
};

export type ChoiceRow = {
  id: string;
  question_id: string;
  position: number;
  choice_text: string | null;
  image_asset_id: string | null;
  image_alt: string | null;
  is_correct: boolean;
  created_at: string;
  updated_at: string;
};

export type RoomRow = {
  id: string;
  owner_id: string;
  quiz_id: string;
  join_token_hash: string;
  join_token_rotated_at: string;
  phase: RoomPhaseDb;
  quiz_snapshot: Json;
  current_question_id: string | null;
  current_question_position: number | null;
  phase_started_at: string | null;
  answer_deadline_at: string | null;
  state_version: number;
  join_open: boolean;
  max_participants: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type RoomMemberRow = {
  id: string;
  room_id: string;
  auth_user_id: string;
  role: RoomMemberRole;
  nickname: string | null;
  joined_at: string;
  last_seen_at: string;
  is_active: boolean;
};

export type AnswerRow = {
  id: string;
  room_id: string;
  question_id: string;
  participant_id: string;
  answer_type: QuestionTypeDb;
  choice_id: string | null;
  number_raw: string | null;
  number_value: string | null;
  answered_at: string;
  elapsed_ms: number;
  is_correct: boolean;
  points_awarded: number;
};

export type PresentationLinkRow = {
  id: string;
  room_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_by: string;
  created_at: string;
};

export type RoomEventRow = {
  id: number;
  room_id: string;
  state_version: number;
  event_type: string;
  payload: Json;
  actor_user_id: string | null;
  created_at: string;
};

type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<ProfileRow>;
      media_assets: TableDef<MediaAssetRow>;
      quizzes: TableDef<QuizRow>;
      questions: TableDef<QuestionRow>;
      choices: TableDef<ChoiceRow>;
      rooms: TableDef<RoomRow>;
      room_members: TableDef<RoomMemberRow>;
      answers: TableDef<AnswerRow>;
      presentation_links: TableDef<PresentationLinkRow>;
      room_events: TableDef<RoomEventRow>;
    };
    Views: Record<never, never>;
    Functions: {
      transition_room: {
        Args: {
          p_room_id: string;
          p_action: string;
          p_expected_version: number;
          p_question_id?: string | null;
        };
        Returns: Json;
      };
      submit_answer: {
        Args: {
          p_room_id: string;
          p_question_id: string;
          p_choice_id?: string | null;
          p_number_raw?: string | null;
          p_number_value?: string | null;
        };
        Returns: Json;
      };
      register_participant: {
        Args: {
          p_room_id: string;
          p_nickname: string;
        };
        Returns: Json;
      };
      validate_quiz_for_publish: {
        Args: { p_quiz_id: string };
        Returns: Json;
      };
      build_quiz_snapshot: {
        Args: { p_quiz_id: string };
        Returns: Json;
      };
      room_answer_breakdown: {
        Args: { p_room_id: string; p_question_id: string };
        Returns: Json;
      };
      room_leaderboard: {
        Args: { p_room_id: string; p_limit: number };
        Returns: Json;
      };
    };
    Enums: {
      quiz_status: QuizStatus;
      question_type: QuestionTypeDb;
      number_judgement_mode: NumberJudgementModeDb;
      room_phase: RoomPhaseDb;
      room_member_role: RoomMemberRole;
    };
    CompositeTypes: Record<never, never>;
  };
};
