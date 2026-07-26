# 🚌 JUIT Smart Shuttle Management System

A C-based smart hostel shuttle request and verification system designed to improve transportation between JUIT Solan's campus and its off-campus hostels.

The project focuses on creating a simple and efficient workflow where students can request a shuttle pickup when needed, while guards can independently verify and approve or reject those requests.

> 🚧 **Project Status:** Currently under development — Core student request, file handling, and guard verification features are being implemented.

---

## 📌 Overview

Due to increased hostel occupancy, students may be accommodated in hostels located outside the main campus. This creates a need for an efficient shuttle transportation system that can handle dynamic student pickup requests without unnecessary trips or fuel consumption.

The **JUIT Smart Shuttle Management System** aims to solve this by allowing:

- Students to submit shuttle pickup requests when required.
- Requests to be temporarily stored and passed to the verification system.
- Guards to independently access pending requests.
- Guards to verify student details before approving a request.
- Approved requests to eventually be integrated into a dynamic bus allocation system.

The long-term goal is to create a system that helps optimize shuttle usage, especially during high-demand periods such as **morning and evening travel hours**.

---

## 🎯 Objectives

- Reduce unnecessary shuttle trips and fuel consumption.
- Provide students with an easy way to request transportation.
- Allow guards to verify requests before approval.
- Create a structured communication flow between students and guards.
- Learn and implement core C programming concepts through a practical project.
- Build a foundation that can later be converted into a full web-based application.

---

## 🔄 Current System Workflow

```text
Student Portal
      │
      │ Create Pickup Request
      ▼
Request Created
      │
      │ Status: PENDING_APPROVAL
      ▼
Temporary File Storage
      │
      ▼
Guard Portal
      │
      │ View Request
      ▼
Student Verification
      │
      ├───────────────┐
      ▼               ▼
   APPROVED        REJECTED
