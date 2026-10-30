"""MuJoCo model construction for two articulated boxing athletes."""

from __future__ import annotations

from dataclasses import dataclass
from textwrap import dedent

from .athletes import AthleteProfile, BASELINE_PROFILE


PHYSICS_TIMESTEP = 0.002
CONTROL_DECIMATION = 10
FIGHTER_SIDES = ("blue", "red")
DRILL_PROJECTILE_COUNT = 4


@dataclass(frozen=True)
class JointSpec:
    name: str
    minimum: float
    maximum: float
    stiffness: float
    damping: float
    force: float


def _joint(
    side: str,
    name: str,
    axis: str,
    limits: tuple[float, float],
    stiffness: float,
    damping: float,
    force: float,
) -> tuple[str, JointSpec]:
    full_name = f"{side}_{name}"
    xml = (
        f'<joint name="{full_name}" type="hinge" axis="{axis}" '
        f'range="{limits[0]} {limits[1]}" damping="{damping}" armature="0.025"/>'
    )
    return xml, JointSpec(
        name=full_name,
        minimum=limits[0],
        maximum=limits[1],
        stiffness=stiffness,
        damping=damping,
        force=force,
    )


def _leg(
    side: str,
    leg: str,
    lateral: float,
    forward: float,
    height_scale: float,
) -> tuple[str, list[JointSpec]]:
    contact_type = 2 if side == "blue" else 4
    contact_affinity = 5 if side == "blue" else 3
    hip_flex, hip_flex_spec = _joint(side, f"{leg}_hip_flex", "0 1 0", (-75, 65), 300, 18, 600)
    hip_abduct, hip_abduct_spec = _joint(side, f"{leg}_hip_abduct", "1 0 0", (-35, 35), 260, 18, 520)
    hip_rotate, hip_rotate_spec = _joint(side, f"{leg}_hip_rotate", "0 0 1", (-40, 40), 120, 10, 310)
    knee, knee_spec = _joint(side, f"{leg}_knee", "0 1 0", (0, 140), 360, 22, 650)
    ankle_pitch, ankle_pitch_spec = _joint(side, f"{leg}_ankle_pitch", "0 1 0", (-45, 35), 145, 11, 320)
    ankle_roll, ankle_roll_spec = _joint(side, f"{leg}_ankle_roll", "1 0 0", (-25, 25), 125, 10, 260)
    toe, toe_spec = _joint(side, f"{leg}_toe", "0 1 0", (-30, 45), 60, 5, 120)
    thigh_forward = forward * height_scale
    thigh_length = 0.39 * height_scale
    shin_forward = -forward * 0.75 * height_scale
    shin_length = 0.39 * height_scale
    shoe_length = 0.14 * height_scale
    shoe_height = 0.045 * height_scale
    xml = f"""
      <body name="{side}_{leg}_thigh" pos="0 {lateral} 0">
        {hip_flex}
        {hip_abduct}
        {hip_rotate}
        <geom name="{side}_{leg}_thigh_geom" type="capsule" fromto="0 0 0 {thigh_forward:.4f} 0 {-thigh_length:.4f}" size="{0.075 * height_scale:.4f}" mass="7.1" contype="{contact_type}" conaffinity="{contact_affinity}"/>
        <body name="{side}_{leg}_shin" pos="{thigh_forward:.4f} 0 {-thigh_length:.4f}">
          {knee}
          <geom name="{side}_{leg}_shin_geom" type="capsule" fromto="0 0 0 {shin_forward:.4f} 0 {-shin_length:.4f}" size="{0.058 * height_scale:.4f}" mass="3.6" contype="{contact_type}" conaffinity="{contact_affinity}"/>
          <body name="{side}_{leg}_foot" pos="{shin_forward:.4f} 0 {-shin_length:.4f}">
            {ankle_pitch}
            {ankle_roll}
            <geom name="{side}_{leg}_shoe_geom" type="box" pos="{0.075 * height_scale:.4f} 0 {-0.055 * height_scale:.4f}" size="{shoe_length:.4f} {0.065 * height_scale:.4f} {shoe_height:.4f}" mass="1.0" friction="1.15 0.03 0.004" contype="{contact_type}" conaffinity="{contact_affinity}"/>
            <site name="{side}_{leg}_foot_contact" type="box" pos="{0.075 * height_scale:.4f} 0 {-0.055 * height_scale:.4f}" size="{0.145 * height_scale:.4f} {0.07 * height_scale:.4f} {0.05 * height_scale:.4f}" rgba="0 0 0 0"/>
            <body name="{side}_{leg}_toe_body" pos="{0.19 * height_scale:.4f} 0 {-0.045 * height_scale:.4f}">
              {toe}
              <geom name="{side}_{leg}_toe_geom" type="box" pos="{0.065 * height_scale:.4f} 0 0" size="{0.07 * height_scale:.4f} {0.064 * height_scale:.4f} {0.035 * height_scale:.4f}" mass="0.25" friction="1.2 0.03 0.004" contype="{contact_type}" conaffinity="{contact_affinity}"/>
            </body>
          </body>
        </body>
      </body>
    """
    specs = [
        hip_flex_spec,
        hip_abduct_spec,
        hip_rotate_spec,
        knee_spec,
        ankle_pitch_spec,
        ankle_roll_spec,
        toe_spec,
    ]
    return dedent(xml), specs


def _arm(
    side: str,
    arm: str,
    lateral: float,
    arm_scale: float,
    height_scale: float,
) -> tuple[str, list[JointSpec]]:
    contact_type = 2 if side == "blue" else 4
    contact_affinity = 5 if side == "blue" else 3
    shoulder_pitch, shoulder_pitch_spec = _joint(side, f"{arm}_shoulder_pitch", "0 1 0", (-120, 120), 95, 8, 220)
    shoulder_abduct, shoulder_abduct_spec = _joint(side, f"{arm}_shoulder_abduct", "1 0 0", (-100, 120), 85, 7, 190)
    shoulder_rotate, shoulder_rotate_spec = _joint(side, f"{arm}_shoulder_rotate", "0 0 1", (-95, 95), 70, 6, 160)
    elbow, elbow_spec = _joint(side, f"{arm}_elbow", "0 1 0", (0, 145), 95, 7, 190)
    forearm, forearm_spec = _joint(side, f"{arm}_forearm_rotate", "1 0 0", (-85, 85), 48, 4, 90)
    wrist_pitch, wrist_pitch_spec = _joint(side, f"{arm}_wrist_pitch", "0 1 0", (-45, 45), 42, 4, 75)
    wrist_yaw, wrist_yaw_spec = _joint(side, f"{arm}_wrist_yaw", "0 0 1", (-40, 40), 38, 4, 65)
    upper_forward = 0.09 * arm_scale
    upper_drop = 0.23 * arm_scale
    forearm_forward = 0.14 * arm_scale
    forearm_rise = 0.18 * arm_scale
    xml = f"""
      <body name="{side}_{arm}_upper_arm" pos="0 {lateral:.4f} {0.19 * height_scale:.4f}">
        {shoulder_pitch}
        {shoulder_abduct}
        {shoulder_rotate}
        <geom name="{side}_{arm}_upper_arm_geom" type="capsule" fromto="0 0 0 {upper_forward:.4f} 0 {-upper_drop:.4f}" size="{0.052 * arm_scale:.4f}" mass="2.1" contype="{contact_type}" conaffinity="{contact_affinity}"/>
        <body name="{side}_{arm}_forearm" pos="{upper_forward:.4f} 0 {-upper_drop:.4f}">
          {elbow}
          {forearm}
          <geom name="{side}_{arm}_forearm_geom" type="capsule" fromto="0 0 0 {forearm_forward:.4f} 0 {forearm_rise:.4f}" size="{0.046 * arm_scale:.4f}" mass="1.4" contype="{contact_type}" conaffinity="{contact_affinity}"/>
          <body name="{side}_{arm}_glove" pos="{forearm_forward:.4f} 0 {forearm_rise:.4f}">
            {wrist_pitch}
            {wrist_yaw}
            <geom name="{side}_{arm}_glove_geom" type="ellipsoid" size="0.09 0.075 0.105" mass="0.55" material="{side}_glove" contype="{contact_type}" conaffinity="{contact_affinity}"/>
            <site name="{side}_{arm}_glove_contact" type="ellipsoid" size="0.095 0.08 0.11" rgba="0 0 0 0"/>
          </body>
        </body>
      </body>
    """
    specs = [
        shoulder_pitch_spec,
        shoulder_abduct_spec,
        shoulder_rotate_spec,
        elbow_spec,
        forearm_spec,
        wrist_pitch_spec,
        wrist_yaw_spec,
    ]
    return dedent(xml), specs


def _fighter(
    side: str,
    x: float,
    y: float,
    quaternion: str,
    profile: AthleteProfile,
) -> tuple[str, list[JointSpec]]:
    contact_type = 2 if side == "blue" else 4
    contact_affinity = 5 if side == "blue" else 3
    height_scale = profile.height_m / BASELINE_PROFILE.height_m
    arm_scale = profile.reach_m / BASELINE_PROFILE.reach_m
    width_scale = 0.70 + 0.30 * (profile.mass_kg / BASELINE_PROFILE.mass_kg) ** 0.5
    shoulder_half_width = 0.22 * (0.70 * width_scale + 0.30 * arm_scale)
    hip_half_width = 0.105 * width_scale
    left_leg, left_leg_specs = _leg(side, "left", hip_half_width, 0.10, height_scale)
    right_leg, right_leg_specs = _leg(side, "right", -hip_half_width, -0.08, height_scale)
    left_arm, left_arm_specs = _arm(side, "left", shoulder_half_width, arm_scale, height_scale)
    right_arm, right_arm_specs = _arm(side, "right", -shoulder_half_width, arm_scale, height_scale)
    lumbar_yaw, lumbar_yaw_spec = _joint(side, "lumbar_yaw", "0 0 1", (-35, 35), 120, 10, 260)
    lumbar_pitch, lumbar_pitch_spec = _joint(side, "lumbar_pitch", "0 1 0", (-25, 20), 240, 18, 430)
    lumbar_roll, lumbar_roll_spec = _joint(side, "lumbar_roll", "1 0 0", (-20, 20), 220, 17, 400)
    neck_yaw, neck_yaw_spec = _joint(side, "neck_yaw", "0 0 1", (-55, 55), 38, 4, 65)
    neck_pitch, neck_pitch_spec = _joint(side, "neck_pitch", "0 1 0", (-30, 30), 45, 5, 75)
    xml = f"""
    <body name="{side}_pelvis" pos="{x:.4f} {y:.4f} {0.92 * height_scale:.4f}" quat="{quaternion}">
      <freejoint name="{side}_root_free"/>
      <geom name="{side}_pelvis_geom" type="ellipsoid" size="{0.16 * width_scale:.4f} {0.14 * width_scale:.4f} {0.12 * height_scale:.4f}" mass="9.2" material="{side}_kit" contype="{contact_type}" conaffinity="{contact_affinity}"/>
      <site name="{side}_pelvis_frame" size="0.015" rgba="1 0.75 0.1 1"/>
      {left_leg}
      {right_leg}
      <body name="{side}_abdomen" pos="0 0 {0.11 * height_scale:.4f}">
        {lumbar_yaw}
        {lumbar_pitch}
        {lumbar_roll}
        <geom name="{side}_abdomen_target" type="capsule" fromto="0 0 0 0 0 {0.25 * height_scale:.4f}" size="{0.145 * width_scale:.4f}" mass="12.5" material="{side}_kit" contype="{contact_type}" conaffinity="{contact_affinity}"/>
        <site name="{side}_body_contact" type="ellipsoid" pos="0 0 {0.12 * height_scale:.4f}" size="{0.16 * width_scale:.4f} {0.15 * width_scale:.4f} {0.22 * height_scale:.4f}" rgba="0 0 0 0"/>
        <body name="{side}_chest" pos="0 0 {0.25 * height_scale:.4f}">
          <geom name="{side}_chest_target" type="ellipsoid" pos="0 0 {0.08 * height_scale:.4f}" size="{0.19 * width_scale:.4f} {0.16 * width_scale:.4f} {0.21 * height_scale:.4f}" mass="18.0" material="{side}_kit" contype="{contact_type}" conaffinity="{contact_affinity}"/>
          {left_arm}
          {right_arm}
          <body name="{side}_neck" pos="0 0 {0.27 * height_scale:.4f}">
            {neck_yaw}
            {neck_pitch}
            <geom name="{side}_neck_geom" type="capsule" fromto="0 0 0 0 0 {0.10 * height_scale:.4f}" size="{0.055 * width_scale:.4f}" mass="1.2" contype="{contact_type}" conaffinity="{contact_affinity}"/>
            <body name="{side}_head" pos="0 0 {0.13 * height_scale:.4f}">
              <geom name="{side}_head_target" type="ellipsoid" size="{0.105 * width_scale:.4f} {0.09 * width_scale:.4f} {0.125 * height_scale:.4f}" mass="4.7" material="skin" contype="{contact_type}" conaffinity="{contact_affinity}"/>
              <site name="{side}_head_contact" type="ellipsoid" size="{0.11 * width_scale:.4f} {0.095 * width_scale:.4f} {0.13 * height_scale:.4f}" rgba="0 0 0 0"/>
              <site name="{side}_head_imu" size="0.012" rgba="0 0 0 0"/>
            </body>
          </body>
        </body>
      </body>
    </body>
    """
    specs = [
        *left_leg_specs,
        *right_leg_specs,
        lumbar_yaw_spec,
        lumbar_pitch_spec,
        lumbar_roll_spec,
        neck_yaw_spec,
        neck_pitch_spec,
        *left_arm_specs,
        *right_arm_specs,
    ]
    return dedent(xml), specs


def _actuators(specs: list[JointSpec]) -> str:
    rows = []
    for spec in specs:
        maximum = max(abs(spec.minimum), abs(spec.maximum)) * 0.017453292519943295
        rows.append(
            f'<position name="{spec.name}_motor" joint="{spec.name}" '
            f'kp="{spec.stiffness}" kv="{spec.damping}" '
            f'ctrlrange="{-maximum:.6f} {maximum:.6f}" '
            f'forcerange="{-spec.force:.1f} {spec.force:.1f}"/>'
        )
    return "\n".join(rows)


def _sensors(side: str) -> str:
    return f"""
    <touch name="{side}_left_foot_force" site="{side}_left_foot_contact"/>
    <touch name="{side}_right_foot_force" site="{side}_right_foot_contact"/>
    <touch name="{side}_left_glove_force" site="{side}_left_glove_contact"/>
    <touch name="{side}_right_glove_force" site="{side}_right_glove_contact"/>
    <touch name="{side}_head_force" site="{side}_head_contact"/>
    <touch name="{side}_body_force" site="{side}_body_contact"/>
    <accelerometer name="{side}_head_acceleration" site="{side}_head_imu"/>
    <gyro name="{side}_head_angular_velocity" site="{side}_head_imu"/>
    <subtreecom name="{side}_center_of_mass" body="{side}_pelvis"/>
    """


def _drill_projectiles() -> str:
    return "\n".join(
        f"""
        <body name="drill_ball_{index}" pos="0 0 {-3.0 - index}">
          <freejoint name="drill_ball_{index}_free"/>
          <geom name="drill_ball_{index}_geom" type="sphere" size="0.085" mass="0.45"
            material="drill_ball" contype="8" conaffinity="6" friction="0.25 0.01 0.001"
            solref="0.012 1" solimp="0.85 0.95 0.004"/>
        </body>
        """
        for index in range(DRILL_PROJECTILE_COUNT)
    )


def build_boxing_model_xml(
    profiles: dict[str, AthleteProfile] | None = None,
) -> tuple[str, dict[str, list[JointSpec]]]:
    """Return a complete two-athlete MJCF model and its motor joint metadata."""
    profiles = profiles or {}
    blue, blue_specs = _fighter(
        "blue",
        -0.72,
        -0.10,
        "1 0 0 0",
        profiles.get("blue", BASELINE_PROFILE),
    )
    red, red_specs = _fighter(
        "red",
        0.72,
        0.10,
        "0 0 0 1",
        profiles.get("red", BASELINE_PROFILE),
    )
    specs = {"blue": blue_specs, "red": red_specs}
    xml = f"""
    <mujoco model="forge_boxing_3d">
      <compiler angle="degree" autolimits="true"/>
      <option timestep="{PHYSICS_TIMESTEP}" integrator="implicitfast" gravity="0 0 -9.81" cone="elliptic" iterations="60"/>
      <size njmax="1600" nconmax="500"/>
      <visual>
        <global azimuth="135" elevation="-18"/>
        <headlight ambient="0.2 0.2 0.2" diffuse="0.75 0.75 0.75" specular="0.2 0.2 0.2"/>
      </visual>
      <default>
        <joint limited="true"/>
        <geom condim="4" solref="0.004 1" solimp="0.9 0.97 0.002" friction="0.9 0.03 0.004"/>
        <position ctrllimited="true" forcelimited="true"/>
      </default>
      <asset>
        <texture name="canvas_tex" type="2d" builtin="checker" rgb1="0.035 0.12 0.19" rgb2="0.045 0.16 0.25" width="512" height="512"/>
        <material name="canvas" texture="canvas_tex" texrepeat="6 6" reflectance="0.08"/>
        <material name="blue_kit" rgba="0.02 0.55 0.9 1"/>
        <material name="red_kit" rgba="0.95 0.18 0.16 1"/>
        <material name="blue_glove" rgba="0.02 0.65 1 1"/>
        <material name="red_glove" rgba="1 0.22 0.18 1"/>
        <material name="drill_ball" rgba="0.78 0.92 0.12 1"/>
        <material name="skin" rgba="0.48 0.28 0.19 1"/>
      </asset>
      <worldbody>
        <light pos="0 0 5" dir="0 0 -1" directional="true"/>
        <camera name="broadcast" pos="0 -7.2 2.2" xyaxes="1 0 0 0 0.2 1"/>
        <geom name="ring_floor" type="box" pos="0 0 -0.045" size="3.05 3.05 0.045" material="canvas" contype="1" conaffinity="6" friction="1.1 0.03 0.004"/>
        <geom name="north_rope" type="capsule" fromto="-3.05 3.05 1.05 3.05 3.05 1.05" size="0.025" rgba="0.85 0.88 0.9 1" contype="0" conaffinity="0"/>
        <geom name="south_rope" type="capsule" fromto="-3.05 -3.05 1.05 3.05 -3.05 1.05" size="0.025" rgba="0.85 0.88 0.9 1" contype="0" conaffinity="0"/>
        {blue}
        {red}
        {_drill_projectiles()}
      </worldbody>
      <sensor>
        {_sensors("blue")}
        {_sensors("red")}
      </sensor>
      <actuator>
        {_actuators(blue_specs)}
        {_actuators(red_specs)}
      </actuator>
    </mujoco>
    """
    return dedent(xml), specs
